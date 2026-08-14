import { NextRequest, NextResponse } from "next/server";
import { fetchBoxScore, fetchGames, type KboGame } from "@/lib/crawler/kbo-api";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchChannelRss, type RssVideoEntry } from "@/lib/video/rss-parser";
import {
  matchPostgameInterview,
  nextPostgameInterviewCollectionAt,
  APPROVED_INTERVIEW_CHANNELS,
  POSTGAME_INTERVIEW_START_MS,
  POSTGAME_INTERVIEW_WINDOW_MS,
  type InterviewMatchContext,
} from "@/lib/video/postgame-interviews";
import {
  contextFromStoredJob,
  doubleheaderGameIds,
} from "@/lib/video/postgame-interviews-route-policy";
import {
  notifyFavPlayerInterviews,
  type InterviewNotifySummary,
} from "@/lib/notifications/fav-player-interview";
import { createInterviewDeps } from "@/lib/notifications/fav-player-interview-deps";

const CRON_SECRET = process.env.CRON_SECRET || "";
const KBO_SCOREBOARD_URL = "https://www.koreabaseball.com/ws/Schedule.asmx/GetScoreBoard";
const KBO_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Referer": "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
};

export const maxDuration = 60;

interface JobRow {
  game_id: string;
  game_date: string;
  away_team_id: number;
  home_team_id: number;
  away_team_name: string | null;
  home_team_name: string | null;
  away_score: number | null;
  home_score: number | null;
  winner_team_id: number;
  is_doubleheader: boolean;
  ended_at: string;
  expires_at: string;
  next_collect_at: string;
  attempts: number;
}

function kstDate(offsetDays = 0): string {
  const shifted = new Date(Date.now() + 9 * 60 * 60 * 1000 + offsetDays * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

function kstHour(): number {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
}

function compactDate(iso: string): string {
  return iso.replace(/-/g, "");
}

function isoGameDate(value: string): string | null {
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function gameEndIso(gameDate: string, rawEndTime: string): string | null {
  const match = /(\d{1,2}):(\d{2})/.exec(rawEndTime);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  const iso = new Date(`${gameDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`);
  return Number.isFinite(iso.getTime()) ? iso.toISOString() : null;
}

async function fetchGameEndIso(game: KboGame): Promise<string | null> {
  try {
    const body = `leId=1&srId=0&seasonId=${game.gameId.slice(0, 4)}&gameId=${game.gameId}`;
    const response = await fetch(KBO_SCOREBOARD_URL, {
      method: "POST",
      headers: KBO_HEADERS,
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const meta = Array.isArray(data?.[0]) ? data[0][0] : null;
    const gameDate = isoGameDate(game.date);
    return gameDate
      ? gameEndIso(gameDate, String(meta?.GAME_END_TM ?? meta?.END_TM ?? ""))
      : null;
  } catch {
    return null;
  }
}

function winnerTeamId(game: KboGame): number | null {
  if (game.awayScore == null || game.homeScore == null || game.awayScore === game.homeScore) return null;
  return game.awayScore > game.homeScore ? game.awayTeamId : game.homeTeamId;
}

async function seedNewFinalJobs(): Promise<{ seeded: number; faults: number }> {
  // 경기 종료 감지는 KST 12:00~03:59에만 수행한다. 후속 job 처리는 하루 종일 계속된다.
  const hour = kstHour();
  if (hour >= 4 && hour < 12) return { seeded: 0, faults: 0 };
  const dates = hour < 4 ? [kstDate(-1), kstDate()] : [kstDate()];

  let faults = 0;
  const finals: KboGame[] = [];
  const scheduledGames: KboGame[] = [];
  // 더블헤더 판정은 종료 여부와 무관하게 당일 전체 일정의 동일 대진 수로 계산해
  // seed 시점에 영속한다. 1차전만 final이고 2차전이 scheduled/live인 구간에도
  // 1차전 job이 is_doubleheader=true로 고정되어 오매핑을 막는다.
  for (const date of dates) {
    try {
      const games = await fetchGames(compactDate(date), undefined, { timeoutMs: 5_000 });
      scheduledGames.push(...games);
      finals.push(...games.filter((game) => game.status === "final" && winnerTeamId(game) !== null));
    } catch {
      faults++;
    }
  }
  if (finals.length === 0) return { seeded: 0, faults };

  // query-guard: bounded -- KBO 하루 경기 최대 10건(자정 복구 시 이틀 20건)의 exact game_id IN 조회.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("postgame_interview_jobs")
    .select("game_id, away_team_name, home_team_name, away_score, home_score")
    .in("game_id", finals.map((game) => game.gameId));
  if (existingError) faults++;
  const existingById = new Map((existing ?? []).map((row) => [row.game_id as string, row]));
  const existingIds = new Set(existingById.keys());
  const metadataUpdates = finals.filter((game) => {
    const row = existingById.get(game.gameId);
    return row && (
      row.away_team_name !== game.awayName
      || row.home_team_name !== game.homeName
      || row.away_score !== game.awayScore
      || row.home_score !== game.homeScore
    );
  });
  const metadataResults = await Promise.all(metadataUpdates.map((game) => (
    supabaseAdmin
      .from("postgame_interview_jobs")
      .update({
        away_team_name: game.awayName,
        home_team_name: game.homeName,
        away_score: game.awayScore,
        home_score: game.homeScore,
      })
      .eq("game_id", game.gameId)
  )));
  faults += metadataResults.filter((result) => result.error).length;
  const missing = finals.filter((game) => !existingIds.has(game.gameId));
  if (missing.length === 0) return { seeded: 0, faults };

  const nowMs = Date.now();
  const doubleheaders = doubleheaderGameIds(scheduledGames);
  const endedAtValues = await Promise.all(missing.map((game) => fetchGameEndIso(game)));
  const rows = missing.flatMap((game, index) => {
    const gameDate = isoGameDate(game.date);
    if (!gameDate) return [];
    const parsedEndMs = Date.parse(endedAtValues[index] ?? "");
    const endedAtMs = Number.isFinite(parsedEndMs) && parsedEndMs <= nowMs
      ? parsedEndMs
      : nowMs;
    const expiresAtMs = endedAtMs + POSTGAME_INTERVIEW_WINDOW_MS;
    if (expiresAtMs <= nowMs) return [];
    const collectAfterMs = endedAtMs + POSTGAME_INTERVIEW_START_MS;
    return [{
      game_id: game.gameId,
      game_date: gameDate,
      away_team_id: game.awayTeamId,
      home_team_id: game.homeTeamId,
      away_team_name: game.awayName,
      home_team_name: game.homeName,
      away_score: game.awayScore,
      home_score: game.homeScore,
      winner_team_id: winnerTeamId(game)!,
      is_doubleheader: doubleheaders.has(game.gameId),
      ended_at: new Date(endedAtMs).toISOString(),
      collect_after: new Date(collectAfterMs).toISOString(),
      expires_at: new Date(expiresAtMs).toISOString(),
      next_collect_at: new Date(Math.max(nowMs, collectAfterMs)).toISOString(),
      status: "collecting",
    }];
  });
  if (rows.length === 0) return { seeded: 0, faults };

  const { data: inserted, error } = await supabaseAdmin
    .from("postgame_interview_jobs")
    .upsert(rows, { onConflict: "game_id", ignoreDuplicates: true })
    .select("game_id");
  if (error) return { seeded: 0, faults: faults + 1 };
  return { seeded: inserted?.length ?? 0, faults };
}

async function loadContexts(jobs: JobRow[]): Promise<InterviewMatchContext[]> {
  const contexts = await Promise.all(jobs.map(async (job) => {
    const boxScore = await fetchBoxScore(job.game_id);
    if (!boxScore) return null;

    // gameId 코드→teamId는 collector job에 양팀이 저장돼 있지만 winner 쪽 판별에는
    // boxScore 배열 순서만 필요하다. winner가 away인지 job 조회 없이 알 수 있게
    // active row에서 양팀 id도 함께 선택한다.
    const winnerPlayers =
      job.winner_team_id === job.away_team_id
        ? [...boxScore.awayBatters, ...boxScore.awayPitchers]
        : job.winner_team_id === job.home_team_id
          ? [...boxScore.homeBatters, ...boxScore.homePitchers]
          : [];
    const names = [...new Set(winnerPlayers.map((player) => player.name.trim()).filter(Boolean))];
    if (names.length === 0) return null;
    // 더블헤더 여부는 seed 시점 당일 전체 일정 기준으로 job에 영속된 값을 쓴다.
    // active job 수를 다시 세면 1차전만 남은 구간에서 오판정된다.
    return contextFromStoredJob(job, names);
  }));
  return contexts.filter((context): context is InterviewMatchContext => context !== null);
}

export async function GET(req: NextRequest) {
  if (!CRON_SECRET || req.headers.get("authorization") !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const seed = await seedNewFinalJobs();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const { error: expiryError } = await supabaseAdmin
    .from("postgame_interview_jobs")
    .update({ status: "expired", updated_at: nowIso })
    .eq("status", "collecting")
    .lte("expires_at", nowIso);

  // query-guard: bounded -- 종료+24시간 수명의 active job만, KBO 동시 경기 이틀 상한에 맞춰 20행 처리.
  const { data: activeRows, error: jobsError } = await supabaseAdmin
    .from("postgame_interview_jobs")
    .select("game_id, game_date, away_team_id, home_team_id, away_team_name, home_team_name, away_score, home_score, winner_team_id, is_doubleheader, ended_at, expires_at, next_collect_at, attempts")
    .eq("status", "collecting")
    .gt("expires_at", nowIso)
    .order("next_collect_at", { ascending: true })
    .limit(20);
  if (jobsError) {
    return NextResponse.json({ ok: false, error: "jobs query failed", seed }, { status: 500 });
  }

  const activeJobs = (activeRows ?? []) as JobRow[];
  const dueJobs = activeJobs.filter((job) => Date.parse(job.next_collect_at) <= nowMs);
  if (dueJobs.length === 0) {
    // 수집할 job이 없어도 인터뷰 알림 복구는 반드시 돈다. 마지막 수집 run에서
    // FCM/DB가 실패하거나 job이 만료된 뒤에도 pending·만료 lease를 재시도해야 한다.
    let interviewNotify: InterviewNotifySummary | { error: string } | null = null;
    try {
      interviewNotify = await notifyFavPlayerInterviews(createInterviewDeps());
    } catch (e) {
      interviewNotify = { error: e instanceof Error ? e.message : String(e) };
      console.error("[postgame-interviews] notify recovery failed:", interviewNotify.error);
    }
    return NextResponse.json({
      ok: seed.faults === 0 && !("error" in (interviewNotify ?? {})),
      seed, active: activeJobs.length, due: 0, interviewNotify,
    });
  }

  const [contexts, feedResults] = await Promise.all([
    loadContexts(activeJobs),
    Promise.allSettled(
      APPROVED_INTERVIEW_CHANNELS.map(async (channel) => ({
        channel,
        entries: await fetchChannelRss(channel.channelId),
      })),
    ),
  ]);

  const feeds = feedResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const feedFaults = feedResults.length - feeds.length;
  const dueIds = new Set(dueJobs.map((job) => job.game_id));
  const interviewRows: Record<string, unknown>[] = [];
  for (const feed of feeds) {
    for (const entry of feed.entries as RssVideoEntry[]) {
      const match = matchPostgameInterview(entry, feed.channel, contexts);
      if (!match || !dueIds.has(match.gameId)) continue;
      interviewRows.push({
        game_id: match.gameId,
        video_id: entry.video_id,
        title: entry.title,
        channel: entry.channel || feed.channel.name,
        channel_id: entry.channel_id,
        thumbnail: entry.thumbnail || null,
        published_at: entry.published_at,
        player_names: match.playerNames,
        source_kind: feed.channel.sourceKind,
        confidence: "high",
      });
    }
  }

  let stored = 0;
  let storeError: string | null = null;
  // 이번 run에 실제로 새로 insert된 video_id만 반환(ignoreDuplicates) → 알림도 이 집합만.
  let insertedVideoIds: string[] = [];
  if (interviewRows.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("postgame_interviews")
      .upsert(interviewRows, { onConflict: "game_id,video_id", ignoreDuplicates: true })
      .select("video_id");
    if (error) storeError = error.message;
    else {
      stored = data?.length ?? 0;
      insertedVideoIds = (data ?? []).map((r) => r.video_id as string);
    }
  }

  // ── 최애선수 수훈 인터뷰 알림 ──
  // 기존 파이프라인이 이미 game_id·player_names를 확정했으므로 여기서 감지·문자열
  // 분석은 하지 않는다. 대상은 이번 run의 새 insert가 아니라 **DB lease가 선점한
  // pending/만료 processing 행**이다 — 새 insert만 보면 발송 실패 시 다음 run에
  // 재입력되지 않아 영구 유실된다. 모듈이 원장을 직접 조회하므로 인자가 없다.
  // best-effort — 실패해도 cron 본연(수집)을 막지 않고, 미발송 행은 다음 run이 재시도.
  let interviewNotify: InterviewNotifySummary | { error: string } | null = null;
  try {
    interviewNotify = await notifyFavPlayerInterviews(createInterviewDeps());
  } catch (e) {
    interviewNotify = { error: e instanceof Error ? e.message : String(e) };
    console.error("[postgame-interviews] notify failed:", interviewNotify.error);
  }

  const contextIds = new Set(contexts.map((context) => context.gameId));
  const updateResults = await Promise.all(dueJobs.map(async (job) => {
    const policyNext = nextPostgameInterviewCollectionAt(Date.parse(job.ended_at), nowMs);
    const retrySoon = feeds.length === 0 || !contextIds.has(job.game_id) || storeError !== null;
    const nextMs = retrySoon
      ? Math.min(nowMs + 15 * 60_000, Date.parse(job.expires_at))
      : policyNext;
    const { error } = await supabaseAdmin
      .from("postgame_interview_jobs")
      .update({
        attempts: job.attempts + 1,
        last_collected_at: nowIso,
        next_collect_at: new Date(nextMs ?? Date.parse(job.expires_at)).toISOString(),
        status: nextMs === null ? "expired" : "collecting",
        last_error: retrySoon
          ? storeError ?? `feed/context unavailable (${feeds.length}/${contexts.length})`
          : feedFaults > 0
            ? `${feedFaults} channel feed(s) unavailable`
            : null,
        updated_at: nowIso,
      })
      .eq("game_id", job.game_id);
    return error;
  }));
  const jobUpdateFaults = updateResults.filter(Boolean).length;
  const fatalError = storeError !== null || expiryError !== null || jobUpdateFaults > 0;

  return NextResponse.json({
    ok: seed.faults === 0 && !fatalError,
    seed,
    active: activeJobs.length,
    due: dueJobs.length,
    feeds: feeds.length,
    feedFaults,
    candidates: interviewRows.length,
    stored,
    interviewNotify,
    storeError,
    expiryError: expiryError?.message ?? null,
    jobUpdateFaults,
  }, { status: fatalError ? 500 : 200 });
}
