/**
 * B안 Phase 1: 선수별 숏츠 확장 수집 (YouTube Data API)
 * 스케줄: vercel.json crons - 6시간마다 30분 (Vercel cron = UTC 기준)
 *   UTC 00:30 / 06:30 / 12:30 / 18:30
 *   KST 09:30 / 15:30 / 21:30 / 03:30 (+9h)
 *   → videos(15분) 직후 동일 사이클에 실행, 중복 없음
 *
 * 전략:
 *  1. players_roster에서 TOP N 선수 선발 (스탯 기반 — 타자 HR/AVG + 투수 ERA/K)
 *  2. 각 선수 "이름 + 팀" 쿼리로 videoDuration=short + order=date 검색
 *  3. quota degrade: 사용률 80% 초과 시 skip
 *
 * FEATURE_PLAYER_SEARCH=false 면 전체 skip (RSS만으로 운영)
 *
 * quota 추정:
 *  - search.list 1회 = 100 units
 *  - 기본 TOP 20명 × 4회/일 = 8,000 units/일 (일일 한도 10,000 대비 margin 2,000)
 *  - → 기본값 TOP 20, 환경변수로 조절
 *
 * 데가드 방어망 2단:
 *  1. pre-budget cap: YT_QUOTA_DAILY_LIMIT * 0.8 로 사전 호출 수 제한
 *  2. runtime degrade: YouTube quotaExceeded 에러 감지 시 나머지 skip + job_runs warning
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import {
  extractNoiseFlags,
  isShortCandidate,
} from "@/lib/video/noise-flags";
import { upsertVideos, type VideoUpsertRow } from "@/lib/video/videos-repo";
import { isOfficialChannel } from "@/lib/video/team-channels";

const CRON_SECRET = process.env.CRON_SECRET || "";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const FEATURE_PLAYER_SEARCH = process.env.FEATURE_PLAYER_SEARCH !== "false";
const PLAYER_TOP_N = parseInt(process.env.VIDEOS_PLAYER_TOP_N || "20", 10);
const YT_QUOTA_DAILY_LIMIT = parseInt(process.env.YT_QUOTA_DAILY_LIMIT || "10000", 10);
// 0.8 → 0.5: RSS cron duration backfill에 quota 여유 확보
const YT_QUOTA_DEGRADE_RATIO = 0.5;
const SEARCH_COST = 100;
const SEARCH_MAX_RESULTS = 15;

export const maxDuration = 60;

function decodeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

interface YouTubeSearchApiItem {
  id: { videoId: string };
  snippet: {
    title: string;
    channelId?: string;
    channelTitle: string;
    publishedAt: string;
    thumbnails?: {
      default?: { url: string };
      medium?: { url: string };
      high?: { url: string };
    };
  };
}

async function searchPlayerShorts(query: string): Promise<
  Array<{
    video_id: string;
    title: string;
    thumbnail: string | null;
    channel: string;
    channel_id: string | null;
    published_at: string;
  }>
> {
  const url =
    `https://www.googleapis.com/youtube/v3/search` +
    `?part=snippet&q=${encodeURIComponent(query)}` +
    `&type=video&maxResults=${SEARCH_MAX_RESULTS}` +
    `&order=date&videoDuration=short&videoEmbeddable=true` +
    `&key=${YOUTUBE_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return (data.items || []).map((it: YouTubeSearchApiItem) => ({
    video_id: it.id.videoId,
    title: decodeHtml(it.snippet.title),
    thumbnail:
      it.snippet.thumbnails?.high?.url ||
      it.snippet.thumbnails?.medium?.url ||
      it.snippet.thumbnails?.default?.url ||
      null,
    channel: it.snippet.channelTitle,
    channel_id: it.snippet.channelId || null,
    published_at: it.snippet.publishedAt,
  }));
}

interface TopPlayer {
  kbo_id: string;
  name: string;
  team: string;
}

/** 스탯 기준 TOP N 선수 추출 (타자 HR DESC + 투수 ERA ASC 혼합) */
async function getTopPlayers(n: number): Promise<TopPlayer[]> {
  // 타자 TOP (홈런/타율)
  const { data: batters } = await supabaseAdmin
    .from("player_stats_batter")
    .select("name, team, hr, avg")
    .gte("hr", 5)
    .order("hr", { ascending: false })
    .limit(Math.ceil(n * 0.7));

  // 투수 TOP (탈삼진/승)
  const { data: pitchers } = await supabaseAdmin
    .from("player_stats_pitcher")
    .select("name, team, so, wins")
    .gte("so", 10)
    .order("so", { ascending: false })
    .limit(Math.ceil(n * 0.3));

  // roster에서 kbo_id 매칭
  const names = new Set<string>();
  for (const r of [...(batters || []), ...(pitchers || [])]) {
    if (r.name) names.add(`${r.team}::${r.name}`);
  }
  if (names.size === 0) return [];

  const teams = Array.from(new Set(Array.from(names).map((k) => k.split("::")[0])));
  const { data: roster } = await supabaseAdmin
    .from("players_roster")
    .select("kbo_id, name, team")
    .in("team", teams);

  const rosterMap = new Map<string, TopPlayer>();
  for (const r of roster || []) {
    rosterMap.set(`${r.team}::${r.name}`, {
      kbo_id: r.kbo_id,
      name: r.name,
      team: r.team,
    });
  }

  const out: TopPlayer[] = [];
  for (const key of names) {
    const p = rosterMap.get(key);
    if (p) out.push(p);
    if (out.length >= n) break;
  }
  return out;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const logId = await startJob("videos-player-shorts");

  if (!FEATURE_PLAYER_SEARCH) {
    await finishJob(logId, "success", "FEATURE_PLAYER_SEARCH=false — skipped");
    return NextResponse.json({ ok: true, skipped: true, reason: "feature_disabled" });
  }

  if (!YOUTUBE_API_KEY) {
    await finishJob(logId, "error", undefined, "YOUTUBE_API_KEY missing");
    return NextResponse.json({ error: "YOUTUBE_API_KEY missing" }, { status: 500 });
  }

  // TOP N 선수
  let players: TopPlayer[];
  try {
    players = await getTopPlayers(PLAYER_TOP_N);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishJob(logId, "error", undefined, `getTopPlayers: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  if (players.length === 0) {
    await finishJob(logId, "success", "no top players");
    return NextResponse.json({ ok: true, players: 0 });
  }

  // Pre-budget cap (사전 제한)
  const budget = Math.floor(YT_QUOTA_DAILY_LIMIT * YT_QUOTA_DEGRADE_RATIO);
  const maxCalls = Math.floor(budget / SEARCH_COST);
  const toQuery = players.slice(0, maxCalls);

  const errors: Record<string, string> = {};
  let totalUpserted = 0;
  let queriedCount = 0;
  let quotaTripped = false; // runtime degrade (YouTube API가 quotaExceeded 반환 시)

  /** YouTube API quota 계열 에러 감지 */
  function isQuotaError(msg: string): boolean {
    const m = msg.toLowerCase();
    return (
      m.includes("quotaexceeded") ||
      m.includes("quota exceeded") ||
      m.includes("dailylimitexceeded") ||
      m.includes("usagelimits")
    );
  }

  for (const p of toQuery) {
    if (quotaTripped) break; // degrade: 이후 쿼리 전부 skip
    try {
      const query = `${p.name} ${p.team}`;
      const items = await searchPlayerShorts(query);
      queriedCount += 1;

      const rows: VideoUpsertRow[] = items.map((it) => {
        const noiseFlags = extractNoiseFlags(it.title, it.channel);
        const isShort = isShortCandidate({ title: it.title });
        const official = isOfficialChannel(it.channel_id);
        return {
          video_id: it.video_id,
          team_id: p.team,
          player_id: p.kbo_id,
          title: it.title,
          channel: it.channel,
          channel_id: it.channel_id,
          thumbnail: it.thumbnail,
          published_at: it.published_at,
          duration_seconds: null,
          source_type: official ? "official_short" : "player",
          is_short_candidate: isShort,
          noise_flags: noiseFlags,
        };
      });

      const { upserted, error } = await upsertVideos(supabaseAdmin, rows);
      if (error) {
        errors[`${p.team}/${p.name}`] = error;
      } else {
        totalUpserted += upserted;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors[`${p.team}/${p.name}`] = msg;
      if (isQuotaError(msg)) {
        quotaTripped = true; // degrade 발동 — 다음 호출 skip
      }
    }
  }

  const errorCount = Object.keys(errors).length;
  const skippedCount = quotaTripped
    ? toQuery.length - queriedCount - (errorCount === 0 ? 0 : 1)
    : 0;

  // degrade 시에도 실패가 아니라 'success + warning' 으로 기록
  // (삼순이 가드레일: quota 부족은 실패보다 축소/skip + 경고가 맞음)
  const realErrors = quotaTripped ? errorCount - 1 : errorCount;
  const status: "success" | "error" = realErrors === 0 ? "success" : "error";

  const summaryParts = [
    `upserted=${totalUpserted}`,
    `players=${toQuery.length}/${players.length}`,
    `queried=${queriedCount}`,
    `errors=${realErrors}`,
    `quota≈${queriedCount * SEARCH_COST}`,
  ];
  if (quotaTripped) summaryParts.push(`DEGRADE=quota skipped=${Math.max(0, skippedCount)}`);
  const summary = summaryParts.join(" ");

  const errorMessage =
    realErrors > 0
      ? JSON.stringify(errors).slice(0, 900)
      : quotaTripped
        ? "quota degrade: remaining players skipped, job_runs warning only"
        : undefined;

  await finishJob(logId, status, summary, errorMessage);

  return NextResponse.json({
    ok: realErrors === 0,
    status,
    totalUpserted,
    queriedCount,
    playersRequested: players.length,
    playersBudgetCap: toQuery.length,
    quotaEstimate: queriedCount * SEARCH_COST,
    degraded: quotaTripped,
    skippedOnDegrade: Math.max(0, skippedCount),
    errors,
  });
}
