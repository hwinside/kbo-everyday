/**
 * B안 Phase 1: 선수별 숏츠 확장 수집 (YouTube Data API)
 * 스케줄: vercel.json crons - 6시간마다 30분 (Vercel cron = UTC 기준)
 *   UTC 00:30 / 06:30 / 12:30 / 18:30
 *   KST 09:30 / 15:30 / 21:30 / 03:30 (+9h)
 *   → videos(15분) 직후 동일 사이클에 실행, 중복 없음
 *
 * 전략:
 *  1. 스탯 테이블에서 TOP N 선수 선발 (타자 HR/AVG + 투수 SO/W), kbo_id는 스탯 테이블 컬럼 직접 사용
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
import {
  hasNonBaseballSignal,
  isPlayerShortRelevant,
} from "@/lib/video/shorts-relevance";
import { reserveQuota, quotaJobStatus } from "@/lib/video/youtube-quota";

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

/** 스탯 기준 TOP N 선수 추출 (타자 HR DESC + 투수 SO DESC 혼합) */
async function getTopPlayers(n: number): Promise<TopPlayer[]> {
  // 타자 TOP (홈런/타율)
  const { data: batters } = await supabaseAdmin
    .from("player_stats_batter")
    .select("kbo_id, name, team, hr, avg")
    .gte("hr", 5)
    .order("hr", { ascending: false })
    .limit(Math.ceil(n * 0.7));

  // 투수 TOP (탈삼진/승)
  const { data: pitchers } = await supabaseAdmin
    .from("player_stats_pitcher")
    .select("kbo_id, name, team, so, wins")
    .gte("so", 10)
    .order("so", { ascending: false })
    .limit(Math.ceil(n * 0.3));

  // kbo_id는 스탯 테이블 컬럼을 직접 사용 (이전엔 deprecated players_roster 조인 →
  // 0건 → "no top players"로 선수 숏츠 수집이 죽어 있었음). 외국인(FP0xx) 포함 전 선수 커버.
  const seen = new Set<string>();
  const out: TopPlayer[] = [];
  for (const r of [...(batters || []), ...(pitchers || [])]) {
    if (!r.name || !r.team || !r.kbo_id) continue;
    const key = `${r.team}::${r.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kbo_id: String(r.kbo_id), name: r.name, team: r.team });
    if (out.length >= n) break;
  }
  return out;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
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

  let ledgerSkipped = 0; // 공유 원장 잔여부족으로 건너뛴 검색
  let ledgerErr: string | undefined; // 원장 RPC 장애(백스톱으로 진행했지만 warning으로 노출)

  for (const p of toQuery) {
    if (quotaTripped) break; // degrade: 이후 쿼리 전부 skip
    // 공유 quota 원장 예약 — 잔여가 없으면 doomed 호출 자체를 건너뛴다
    // (여러 YT 크론이 프로젝트 quota를 공유하므로 이 잡만의 budget으론 부족).
    const reservation = await reserveQuota(supabaseAdmin, SEARCH_COST);
    if (reservation.ledgerError && !ledgerErr) ledgerErr = reservation.ledgerError;
    if (!reservation.allowed) {
      quotaTripped = true; // 남은 quota 0 → 이후 전부 skip
      ledgerSkipped = toQuery.length - queriedCount;
      break;
    }
    try {
      const query = `${p.name} ${p.team}`;
      const items = await searchPlayerShorts(query);
      queriedCount += 1;

      const rows: VideoUpsertRow[] = items.flatMap((it) => {
        const official = isOfficialChannel(it.channel_id);
        // 야구 관련성 게이트. 공식 채널은 신뢰하되(하이라이트 제목엔 선수명이
        // 없을 수 있음) 정치·종교 negative만 안전망으로 차단. 검색 기반
        // 'player' 결과는 선수명이 제목에 있어야 + negative 없어야 통과 —
        // 채널명/설명으로만 우연 매칭된 비-야구 영상 차단(2026-06-19 제보).
        const relevant = official
          ? !hasNonBaseballSignal(it.title)
          : isPlayerShortRelevant(it.title, p.name);
        if (!relevant) return [];
        const noiseFlags = extractNoiseFlags(it.title, it.channel);
        const isShort = isShortCandidate({ title: it.title });
        return [{
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
        }];
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
  // 원장 스킵이면 실패 없이 전량 skip, 런타임 403이면 마지막 1건이 quota 에러(실 에러 아님)
  const realErrors = quotaTripped && ledgerSkipped === 0
    ? Math.max(0, errorCount - 1)
    : errorCount;
  const skippedCount = ledgerSkipped > 0
    ? ledgerSkipped
    : quotaTripped
      ? toQuery.length - queriedCount - (errorCount === 0 ? 0 : 1)
      : 0;

  // quota degrade는 실패가 아니라 warning(축소/skip). 성공 오표기 교정(2026-07-19 삼순 지적):
  //   status를 quotaJobStatus로 통일 — hardError>0=error, degrade/원장장애=warning, else success.
  //   원장 RPC 장애(ledgerErr)도 무음 성공으로 숨지 않게 warning으로 들어올린다(삼순 3번).
  const status = quotaJobStatus({ hardErrors: realErrors, degraded: quotaTripped || !!ledgerErr });

  const summaryParts = [
    `upserted=${totalUpserted}`,
    `players=${toQuery.length}/${players.length}`,
    `queried=${queriedCount}`,
    `errors=${realErrors}`,
    `quota≈${queriedCount * SEARCH_COST}`,
  ];
  if (quotaTripped) {
    const cause = ledgerSkipped > 0 ? "ledger-cap" : "runtime-403";
    summaryParts.push(`DEGRADE=quota(${cause}) skipped=${Math.max(0, skippedCount)}`);
  }
  const summary = summaryParts.join(" ");

  if (ledgerErr) summaryParts.push(`LEDGER_ERR=${ledgerErr.slice(0, 60)}`);

  const errorMessage =
    realErrors > 0
      ? JSON.stringify(errors).slice(0, 900)
      : quotaTripped
        ? `quota degrade(${ledgerSkipped > 0 ? "shared ledger cap" : "runtime 403"}): ${Math.max(0, skippedCount)} players skipped — warning, not error`
        : ledgerErr
          ? `quota ledger unavailable (${ledgerErr.slice(0, 120)}) — ran without shared cap, warning`
          : undefined;

  await finishJob(logId, status, summary, errorMessage);

  return NextResponse.json({
    ok: status !== "error",
    status,
    totalUpserted,
    queriedCount,
    playersRequested: players.length,
    playersBudgetCap: toQuery.length,
    quotaEstimate: queriedCount * SEARCH_COST,
    degraded: quotaTripped,
    degradeCause: quotaTripped ? (ledgerSkipped > 0 ? "ledger-cap" : "runtime-403") : null,
    ledgerError: ledgerErr ?? null,
    skippedOnDegrade: Math.max(0, skippedCount),
    errors,
  });
}
