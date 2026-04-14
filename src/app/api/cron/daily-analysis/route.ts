import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import { fetchStandings, fetchGames } from "@/lib/crawler/kbo-api";
import { TEAMS } from "@/lib/constants/teams";
import {
  computeStandingsDelta,
  computeTitlesDelta,
  computeStreak,
  extractGameEvents,
  type StandingsSnapshot,
  type StatsSnapshotRow,
  type StandingsDelta,
  type TitlesDelta,
  type GameEvent,
} from "@/lib/analysis/daily-delta";

const CRON_SECRET = process.env.CRON_SECRET || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const PROMPT_VERSION = 1;

const KBO_BASE = "https://www.koreabaseball.com";

// ===== Date helpers =====

function getKSTDate(offset = 0): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000 + offset * 24 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10); // YYYY-MM-DD
}

function toKboDate(isoDate: string): string {
  return isoDate.replace(/-/g, ""); // YYYYMMDD
}

// ===== HTML fetch helpers (from cron/stats pattern) =====

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: KBO_BASE,
    },
    next: { revalidate: 0 },
  });
  return res.text();
}

function parseTable(html: string): string[][] {
  const rows: string[][] = [];
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return rows;
  const trMatches = tbodyMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  if (!trMatches) return rows;
  for (const tr of trMatches) {
    const cells: string[] = [];
    const tdMatches = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (tdMatches) {
      for (const td of tdMatches) {
        cells.push(td.replace(/<[^>]+>/g, "").trim());
      }
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

// ===== Stats fetchers for title snapshots =====

interface TitleEntry {
  category: string;
  rank: number;
  player_name: string;
  team: string;
  value: number;
}

const BATTER_TITLES: { category: string; sort: string; colIndex: number }[] = [
  { category: "avg", sort: "HRA_RT", colIndex: 3 },
  { category: "hr", sort: "HR_CN", colIndex: 11 },
  { category: "rbi", sort: "RBI_CN", colIndex: 13 },
  { category: "sb", sort: "SB_CN", colIndex: -1 }, // Runner page
];

const PITCHER_TITLES: { category: string; sort: string; colIndex: number }[] = [
  { category: "era", sort: "ERA_RT", colIndex: 3 },
  { category: "wins", sort: "W_CN", colIndex: 5 },
  { category: "k", sort: "KK_CN", colIndex: 15 },
  { category: "saves", sort: "SV_CN", colIndex: 7 },
  { category: "whip", sort: "WHIP_RT", colIndex: 18 },
];

async function fetchBatterTitleEntries(): Promise<TitleEntry[]> {
  const entries: TitleEntry[] = [];

  for (const title of BATTER_TITLES) {
    if (title.category === "sb") {
      const html = await fetchHtml(`${KBO_BASE}/Record/Player/Runner/Basic.aspx?sort=SB_CN`);
      const rows = parseTable(html);
      for (let i = 0; i < Math.min(10, rows.length); i++) {
        const c = rows[i];
        entries.push({
          category: "sb",
          rank: i + 1,
          player_name: c[1] || "",
          team: c[2] || "",
          value: parseInt(c[3]) || 0, // SB column in Runner page
        });
      }
      continue;
    }

    const html = await fetchHtml(`${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx?sort=${title.sort}`);
    const rows = parseTable(html);
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const c = rows[i];
      const raw = c[title.colIndex] || "0";
      entries.push({
        category: title.category,
        rank: i + 1,
        player_name: c[1] || "",
        team: c[2] || "",
        value: parseFloat(raw) || 0,
      });
    }
  }

  return entries;
}

async function fetchPitcherTitleEntries(): Promise<TitleEntry[]> {
  const entries: TitleEntry[] = [];

  for (const title of PITCHER_TITLES) {
    const html = await fetchHtml(`${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx?sort=${title.sort}`);
    const rows = parseTable(html);
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const c = rows[i];
      const raw = c[title.colIndex] || "0";
      entries.push({
        category: title.category,
        rank: i + 1,
        player_name: c[1] || "",
        team: c[2] || "",
        value: parseFloat(raw) || 0,
      });
    }
  }

  return entries;
}

// ===== Gemini prompts =====

function buildStandingsPrompt(delta: StandingsDelta, events: GameEvent[], teamNames: Map<number, string>): string {
  const eventLines = events.map(
    (e) => `${e.awayTeam} ${e.awayScore}:${e.homeScore} ${e.homeTeam} (승: ${e.winPitcher || "-"}, 패: ${e.losePitcher || "-"})`,
  ).join("\n");

  const teamDeltas = [...delta.top, ...delta.mid, ...delta.bottom].map((d) => {
    const name = teamNames.get(d.team_id) || `팀${d.team_id}`;
    const change = d.rankChange > 0 ? `↑${d.rankChange}` : d.rankChange < 0 ? `↓${Math.abs(d.rankChange)}` : "-";
    return `${d.newRank}위 ${name}: ${d.wins}승${d.losses}패${d.draws}무 (승률 ${d.win_rate.toFixed(3)}, ${d.games_behind}게임차) 순위변동: ${change}, 연승연패: ${d.streak || "-"}`;
  }).join("\n");

  return `당신은 KBO 프로야구 전문 데이터 분석 기자입니다.
아래 데이터를 바탕으로 오늘의 순위 동향을 기사체로 작성하세요.

## 핵심 원칙
1. 제공된 데이터 외의 정보를 사용하지 마세요.
2. 상위권(1~3위), 중위권(4~7위), 하위권(8~10위) 3단으로 나누어 서술하세요.
3. 순위 변동이 있는 팀을 중심으로, 왜 변동이 생겼는지 어제 경기 결과와 연결하세요.
4. 연승/연패 중인 팀은 반드시 언급하세요.
5. 구체적 숫자(승률, 게임차)를 자연스럽게 녹여 서술하세요.

## 어제 경기 결과
${eventLines || "경기 없음"}

## 현재 순위 (변동 포함)
${teamDeltas}

## 출력 형식 (JSON 객체 하나만 출력)
{ "content": "순위 동향 기사 본문 (상위권/중위권/하위권 3단, 300~500자)" }`;
}

function buildTitlePrompt(
  delta: TitlesDelta,
  events: GameEvent[],
  type: "batter" | "pitcher",
): string {
  const label = type === "batter" ? "타자 타이틀" : "투수 타이틀";
  const cats = type === "batter"
    ? ["avg", "hr", "rbi", "sb"]
    : ["era", "wins", "k", "saves", "whip"];
  const catNames: Record<string, string> = {
    avg: "타율", hr: "홈런", rbi: "타점", sb: "도루",
    era: "평균자책점", wins: "승수", k: "탈삼진", saves: "세이브", whip: "WHIP",
  };

  const eventLines = events.map(
    (e) => `${e.awayTeam} ${e.awayScore}:${e.homeScore} ${e.homeTeam}`,
  ).join("\n");

  const catData = delta.categories
    .filter((c) => cats.includes(c.category))
    .map((c) => {
      const name = catNames[c.category] || c.category;
      const leader = c.leaderChanged
        ? `1위 교체: ${c.oldLeader?.player_name}(${c.oldLeader?.team}) → ${c.newLeader.player_name}(${c.newLeader.team})`
        : `1위 유지: ${c.newLeader.player_name}(${c.newLeader.team}, ${c.newLeader.value})`;
      const top5 = c.top5.map((p) => {
        const rc = p.rankChange > 0 ? `↑${p.rankChange}` : p.rankChange < 0 ? `↓${Math.abs(p.rankChange)}` : "-";
        return `  ${p.player_name}(${p.team}) ${p.value} [순위변동: ${rc}]`;
      }).join("\n");
      return `### ${name}\n${leader}\n${top5}`;
    }).join("\n\n");

  return `당신은 KBO 프로야구 전문 데이터 분석 기자입니다.
아래 데이터를 바탕으로 오늘의 ${label} 변동을 기사체로 작성하세요.

## 핵심 원칙
1. 제공된 데이터 외의 정보를 사용하지 마세요.
2. 각 카테고리별 변동을 서술하되, 1위 교체가 있으면 중점적으로 다루세요.
3. 어제 경기 결과와 연결해서 왜 수치가 변했는지 설명하세요.
4. 구체적 수치를 자연스럽게 녹여 서술하세요.

## 어제 경기 결과
${eventLines || "경기 없음"}

## ${label} 변동
${catData}

## 출력 형식 (JSON 객체 하나만 출력)
{ "content": "${label} 변동 기사 본문 (200~400자)" }`;
}

// ===== Gemini call =====

async function callGemini(prompt: string): Promise<string> {
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: attempt === 1 ? 0.7 : 0.3,
          maxOutputTokens: 2560,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!res.ok) {
      console.error(`Gemini API error (attempt ${attempt}):`, res.status);
      if (attempt === MAX_ATTEMPTS) throw new Error(`Gemini API failed: ${res.status}`);
      continue;
    }

    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const textParts = parts.filter((p: { text?: string }) => p.text);
    const rawText = textParts.length > 0 ? textParts[textParts.length - 1].text : null;

    if (!rawText) {
      if (attempt === MAX_ATTEMPTS) throw new Error("Empty Gemini response");
      continue;
    }

    try {
      const parsed = JSON.parse(rawText);
      return parsed.content || "";
    } catch {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return parsed.content || "";
        } catch {
          if (attempt === MAX_ATTEMPTS) throw new Error("Invalid Gemini JSON");
          continue;
        }
      }
      if (attempt === MAX_ATTEMPTS) throw new Error("No JSON in Gemini response");
    }
  }

  throw new Error("Gemini call exhausted all attempts");
}

// ===== Main route =====

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const logId = await startJob("daily-analysis");
  const supabase = supabaseAdmin;

  try {
    const todayISO = getKSTDate();
    const yesterdayISO = getKSTDate(-1);
    const yesterdayKbo = toKboDate(yesterdayISO);

    // 1. Fetch current data in parallel
    const [standings, games, batterEntries, pitcherEntries] = await Promise.all([
      fetchStandings(),
      fetchGames(yesterdayKbo),
      fetchBatterTitleEntries(),
      fetchPitcherTitleEntries(),
    ]);

    // 2. Fetch yesterday's snapshots
    const [{ data: yesterdayStandings }, { data: yesterdayStats }] = await Promise.all([
      supabase.from("daily_standings_snapshot").select("*").eq("date", yesterdayISO),
      supabase.from("daily_stats_snapshot").select("*").eq("date", yesterdayISO),
    ]);

    // 3. Build team name map
    const teamNames = new Map(TEAMS.map((t) => [t.id, t.shortName]));

    // 4. Compute streaks and build today's standings snapshot
    const standingsSorted = [...standings].sort((a, b) => {
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      return a.gamesBehind - b.gamesBehind;
    });

    const yesterdayStreakMap = new Map(
      (yesterdayStandings ?? []).map((s: StandingsSnapshot) => [s.team_id, s.streak]),
    );

    const todayStandingsSnapshots: StandingsSnapshot[] = standingsSorted.map((s, i) => ({
      date: todayISO,
      team_id: s.teamId,
      rank: i + 1,
      wins: s.wins,
      losses: s.losses,
      draws: s.draws,
      win_rate: s.winRate,
      games_behind: s.gamesBehind,
      streak: computeStreak(s.teamId, games, yesterdayStreakMap.get(s.teamId) ?? null),
    }));

    // 5. Build today's stats snapshot
    const todayStatsSnapshots: StatsSnapshotRow[] = [...batterEntries, ...pitcherEntries].map((e) => ({
      date: todayISO,
      category: e.category,
      rank: e.rank,
      player_name: e.player_name,
      team: e.team,
      value: e.value,
    }));

    // 6. Save today's snapshots
    const { error: standingsErr } = await supabase
      .from("daily_standings_snapshot")
      .upsert(todayStandingsSnapshots, { onConflict: "date,team_id" });

    const { error: statsErr } = await supabase
      .from("daily_stats_snapshot")
      .upsert(todayStatsSnapshots, { onConflict: "date,category,player_name,team" });

    if (standingsErr) console.error("Standings snapshot upsert error:", standingsErr.message);
    if (statsErr) console.error("Stats snapshot upsert error:", statsErr.message);

    // 7. Check if yesterday data exists — if not, skip analysis (first run)
    const hasYesterdayStandings = !!yesterdayStandings?.length;
    const hasYesterdayStats = !!yesterdayStats?.length;
    if (!hasYesterdayStandings && !hasYesterdayStats) {
      const msg = "첫 실행: 어제 스냅샷 없음 — 스냅샷만 저장, 분석 skip";
      await finishJob(logId, "success", msg);
      return NextResponse.json({ ok: true, message: msg, snapshotsOnly: true });
    }

    // 8. Check if games were played
    const finalGames = games.filter((g) => g.status === "final");
    const noGames = finalGames.length === 0;

    // 9. Compute deltas
    const gameEvents = extractGameEvents(games);
    const standingsDelta = computeStandingsDelta(todayStandingsSnapshots, yesterdayStandings as StandingsSnapshot[]);

    const batterCats = ["avg", "hr", "rbi", "sb"];
    const pitcherCats = ["era", "wins", "k", "saves", "whip"];
    const todayBatterStats = todayStatsSnapshots.filter((s) => batterCats.includes(s.category));
    const todayPitcherStats = todayStatsSnapshots.filter((s) => pitcherCats.includes(s.category));
    const yesterdayBatterStats = ((yesterdayStats ?? []) as StatsSnapshotRow[]).filter((s) => batterCats.includes(s.category));
    const yesterdayPitcherStats = ((yesterdayStats ?? []) as StatsSnapshotRow[]).filter((s) => pitcherCats.includes(s.category));

    const batterDelta = computeTitlesDelta(todayBatterStats, yesterdayBatterStats);
    const pitcherDelta = computeTitlesDelta(todayPitcherStats, yesterdayPitcherStats);

    // 10. Generate narratives with Gemini (or skip if no Gemini key)
    let standingsCopy = "";
    let batterCopy = "";
    let pitcherCopy = "";

    if (noGames) {
      // 경기 없는 날: 어제 분석을 그대로 유지하고 스냅샷만 갱신
      const { data: lastAnalysis } = await supabase
        .from("daily_analysis")
        .select("type, generated_copy, delta_json")
        .eq("date", yesterdayISO);

      if (lastAnalysis?.length) {
        // 어제 분석을 오늘 날짜로 복사 + 업데이트 일자 표시
        const lastMap = new Map(lastAnalysis.map((r: { type: string; generated_copy: string; delta_json: unknown }) => [r.type, r]));
        const lastStandings = lastMap.get("standings");
        const lastBatter = lastMap.get("batter_titles");
        const lastPitcher = lastMap.get("pitcher_titles");
        standingsCopy = lastStandings?.generated_copy ?? "";
        batterCopy = lastBatter?.generated_copy ?? "";
        pitcherCopy = lastPitcher?.generated_copy ?? "";
        // delta_json에 경기 없음 표시 추가
        Object.assign(standingsDelta, { noGames: true, lastUpdated: yesterdayISO });
        Object.assign(batterDelta, { noGames: true, lastUpdated: yesterdayISO });
        Object.assign(pitcherDelta, { noGames: true, lastUpdated: yesterdayISO });
      } else {
        standingsCopy = "";
        batterCopy = "";
        pitcherCopy = "";
      }
    } else if (GEMINI_API_KEY) {
      const promises: Promise<string>[] = [];
      // 순위 분석: 어제 순위 스냅샷이 있으면 생성
      promises.push(hasYesterdayStandings
        ? callGemini(buildStandingsPrompt(standingsDelta, gameEvents, teamNames))
        : Promise.resolve(""));
      // 타자/투수 분석: 어제 스탯 스냅샷이 있으면 생성
      promises.push(hasYesterdayStats
        ? callGemini(buildTitlePrompt(batterDelta, gameEvents, "batter"))
        : Promise.resolve(""));
      promises.push(hasYesterdayStats
        ? callGemini(buildTitlePrompt(pitcherDelta, gameEvents, "pitcher"))
        : Promise.resolve(""));
      [standingsCopy, batterCopy, pitcherCopy] = await Promise.all(promises);
    } else {
      standingsCopy = standingsDelta.summary;
      batterCopy = batterDelta.summary;
      pitcherCopy = pitcherDelta.summary;
    }

    // 11. Save analysis results
    const analysisRows = [
      {
        date: todayISO,
        type: "standings",
        delta_json: standingsDelta,
        generated_copy: standingsCopy,
        prompt_version: PROMPT_VERSION,
        created_at: new Date().toISOString(),
      },
      {
        date: todayISO,
        type: "batter_titles",
        delta_json: batterDelta,
        generated_copy: batterCopy,
        prompt_version: PROMPT_VERSION,
        created_at: new Date().toISOString(),
      },
      {
        date: todayISO,
        type: "pitcher_titles",
        delta_json: pitcherDelta,
        generated_copy: pitcherCopy,
        prompt_version: PROMPT_VERSION,
        created_at: new Date().toISOString(),
      },
    ];

    const { error: analysisErr } = await supabase
      .from("daily_analysis")
      .upsert(analysisRows, { onConflict: "date,type" });

    if (analysisErr) {
      await finishJob(logId, "error", "분석 저장 실패", analysisErr.message);
      return NextResponse.json({ error: analysisErr.message }, { status: 500 });
    }

    const summary = `${todayISO} 분석 완료: ${finalGames.length}경기, ${standingsDelta.summary}, ${batterDelta.summary}`;
    await finishJob(logId, "success", summary);

    return NextResponse.json({
      ok: true,
      date: todayISO,
      gamesAnalyzed: finalGames.length,
      standingsDelta: standingsDelta.summary,
      batterDelta: batterDelta.summary,
      pitcherDelta: pitcherDelta.summary,
    });
  } catch (e) {
    const msg = (e as Error).message;
    await finishJob(logId, "error", undefined, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
