/**
 * 자동 채널 발굴 크론 — 정상 수집 중인 active 채널의 숏츠 제목을 분석해 유사 신규 채널을 발굴·활성화.
 *
 * 스케줄: vercel.json crons — 주 1회(일요일 00:00 UTC = 09:00 KST).
 *   (선수 검색 8,000/day + RSS fallback + duration backfill로 매일 +800 headroom이 없어 주 1회 권고.
 *    공유 quota ledger/cap이 생기면 그때 일 1회 검토.)
 *
 * 흐름:
 *  1. 동시실행 lock claim (실패 시 skip = fail-closed)
 *  2. active channel_pool 채널의 최근 30일 숏츠 제목 + 로스터 → 검색어 ≤8개 생성
 *     (DB 조회 오류는 generic fallback으로 성공 처리하지 않고 fail-closed)
 *  3. 각 검색어 search.list(100 units)로 채널 후보 수집 (기존 channel_pool 채널 전부 제외)
 *  4. 상위 후보의 최근 영상(RSS→API fallback)+duration(videos.list) 확인 → 활성 게이트 평가
 *  5. mode: 완료된 non-degraded shadow 2회 전까지 shadow(로그만) / 이후 active(게이트 통과 최대 5)
 *  6. run/후보별 판정사유 로그 기록 (DB 오류 전부 확인, activated는 pool 반영 성공과 원자적)
 *
 * quota fail-closed:
 *  · search.list 403/429 또는 errors[].reason=quotaExceeded → 이후 검색 중단(degrade)
 *  · duration 조회 403 → 숏츠 0개 판정 → 게이트 탈락(미검증 채널은 활성화 안 함)
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import { fetchChannelRss } from "@/lib/video/rss-parser";
import {
  fetchChannelUploadsViaApi,
  fetchVideoDurations,
} from "@/lib/video/youtube-api";
import {
  buildDiscoveryQueries,
  decideMode,
  evaluateChannelCandidate,
  isQuotaSignal,
  pickActivations,
  resolveMaxActivations,
  type RecentVideo,
  type ScoredCandidate,
} from "@/lib/video/channel-discovery";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";

const CRON_SECRET = process.env.CRON_SECRET || "";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const FEATURE_CHANNEL_DISCOVERY =
  process.env.FEATURE_CHANNEL_DISCOVERY !== "false";
const MAX_QUERIES = Math.min(
  parseInt(process.env.DISCOVER_MAX_QUERIES || "8", 10) || 8,
  8,
);
const MAX_ACTIVATIONS = resolveMaxActivations(process.env.DISCOVER_MAX_ACTIVATIONS);
const MAX_VERIFY = parseInt(process.env.DISCOVER_MAX_VERIFY || "15", 10);
const SEARCH_COST = 100;
const LOCK_STALE_MIN = 15;

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

interface SearchChannelHit {
  channel_id: string;
  channel_name: string;
}

interface SearchResult {
  hits: SearchChannelHit[];
  quota: boolean; // quota/rate 하드 게이트 감지
  error?: string; // 비-quota 단건 오류
}

/** 검색어 1개 → 채널 후보 목록. quota/rate는 status+reason으로 분류(throw 안 함). */
async function searchChannels(query: string): Promise<SearchResult> {
  const url =
    `https://www.googleapis.com/youtube/v3/search` +
    `?part=snippet&q=${encodeURIComponent(query)}` +
    `&type=video&maxResults=50&order=relevance&videoDuration=short` +
    `&key=${YOUTUBE_API_KEY}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    return { hits: [], quota: false, error: err instanceof Error ? err.message : String(err) };
  }

  let data: {
    error?: { message?: string; errors?: Array<{ reason?: string }> };
    items?: Array<{ snippet?: { channelId?: string; channelTitle?: string } }>;
  } | null = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  const reasons = (data?.error?.errors ?? []).map((e) => e.reason);
  const message = data?.error?.message;

  // quota/rate → 하드 게이트(HTTP status + errors[].reason + message 변형)
  if (isQuotaSignal({ status: res.status, reasons, message })) {
    return { hits: [], quota: true, error: message ?? `search ${res.status}` };
  }
  if (data?.error) {
    return { hits: [], quota: false, error: message ?? `search error ${res.status}` };
  }
  if (!res.ok) {
    return { hits: [], quota: false, error: `search http ${res.status}` };
  }

  const hits: SearchChannelHit[] = [];
  for (const it of data?.items ?? []) {
    const cid = it.snippet?.channelId;
    if (!cid) continue;
    hits.push({
      channel_id: cid,
      channel_name: decodeHtml(it.snippet?.channelTitle || ""),
    });
  }
  return { hits, quota: false };
}

/** 채널 최근 영상(RSS 우선, 실패 시 Data API). duration 별도 배치 조회. */
async function fetchRecentVideos(channelId: string): Promise<RecentVideo[] | null> {
  let entries;
  try {
    entries = await fetchChannelRss(channelId);
  } catch {
    entries = await fetchChannelUploadsViaApi(channelId, 15);
  }
  if (entries === null) return null; // 조회 실패 → unverified(fail-closed)
  if (entries.length === 0) return [];

  const top = entries.slice(0, 10);
  const durations = await fetchVideoDurations(top.map((e) => e.video_id));
  return top.map((e) => ({
    title: e.title,
    publishedAt: e.published_at,
    durationSeconds: durations.has(e.video_id) ? durations.get(e.video_id)! : null,
  }));
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const logId = await startJob("channel-discovery");

  if (!FEATURE_CHANNEL_DISCOVERY) {
    await finishJob(logId, "success", "FEATURE_CHANNEL_DISCOVERY=false — skipped");
    return NextResponse.json({ ok: true, skipped: true, reason: "feature_disabled" });
  }
  if (!YOUTUBE_API_KEY) {
    await finishJob(logId, "error", undefined, "YOUTUBE_API_KEY missing");
    return NextResponse.json({ error: "YOUTUBE_API_KEY missing" }, { status: 500 });
  }

  // 1. 동시실행 lock claim (fail-closed)
  const nowIso = new Date().toISOString();
  const staleCutoff = new Date(Date.now() - LOCK_STALE_MIN * 60_000).toISOString();
  const { data: claimed, error: lockErr } = await supabaseAdmin
    .from("channel_discovery_lock")
    .update({ locked_at: nowIso })
    .eq("id", 1)
    .or(`locked_at.is.null,locked_at.lt.${staleCutoff}`)
    .select("id");
  if (lockErr) {
    await finishJob(logId, "error", undefined, `lock: ${lockErr.message}`);
    return NextResponse.json({ error: lockErr.message }, { status: 500 });
  }
  if (!claimed || claimed.length === 0) {
    await finishJob(logId, "success", "skipped: another run holds the lock");
    return NextResponse.json({ ok: true, skipped: true, reason: "locked" });
  }

  let runId: number | null = null;
  try {
    // 2. channel_pool 로드 (active=fed 분석 대상, 전체=후보 제외 대상). 오류 시 fail-closed.
    const { data: pool, error: poolErr } = await supabaseAdmin
      .from("channel_pool")
      .select("channel_id, is_active");
    if (poolErr) throw new Error(`channel_pool load: ${poolErr.message}`);
    const existingIds = new Set((pool ?? []).map((r) => r.channel_id as string));
    const activeIds = (pool ?? [])
      .filter((r) => r.is_active)
      .map((r) => r.channel_id as string);

    // 3. 검색어 생성 — active 채널의 실제 숏츠 제목만 사용 (조회 오류 fail-closed)
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    let fedTitles: string[] = [];
    if (activeIds.length > 0) {
      const { data: fed, error: fedErr } = await supabaseAdmin
        .from("videos")
        .select("title")
        .in("channel_id", activeIds)
        .eq("is_short_candidate", true)
        .gte("published_at", since)
        .order("published_at", { ascending: false })
        .limit(600);
      if (fedErr) throw new Error(`fed titles: ${fedErr.message}`);
      fedTitles = (fed ?? []).map((r) => r.title as string).filter(Boolean);
    }
    const rosterNames = Array.from(
      new Set(
        (PLAYERS_ROSTER as Array<{ name?: string }>)
          .map((p) => p.name)
          .filter((n): n is string => !!n),
      ),
    );
    const queries = buildDiscoveryQueries(fedTitles, rosterNames, MAX_QUERIES);

    // 4. 검색 → 후보 수집 (quota fail-closed)
    const candMap = new Map<string, SearchChannelHit & { seen: number }>();
    let quotaUsed = 0;
    let quotaDegraded = false;
    let searchErrorCount = 0; // 비-quota 검색 오류도 run을 not-clean으로 만든다(삼순 2번)
    for (const q of queries) {
      const r = await searchChannels(q);
      if (r.quota) {
        quotaDegraded = true;
        break; // fail-closed: 이후 검색 중단
      }
      if (r.error) {
        // 비-quota 단건 오류: 스킵하되 run을 not-clean으로 표시(승격/활성화 카운트 오염 차단)
        searchErrorCount += 1;
        await new Promise((rs) => setTimeout(rs, 120));
        continue;
      }
      quotaUsed += SEARCH_COST;
      for (const h of r.hits) {
        if (existingIds.has(h.channel_id)) continue;
        const cur = candMap.get(h.channel_id);
        if (cur) cur.seen += 1;
        else candMap.set(h.channel_id, { ...h, seen: 1 });
      }
      await new Promise((rs) => setTimeout(rs, 120));
    }

    const candidatesFound = candMap.size;

    // 5. 상위 후보 검증 (등장 빈도 desc, 최대 MAX_VERIFY)
    const ranked = [...candMap.values()].sort(
      (a, b) => b.seen - a.seen || a.channel_id.localeCompare(b.channel_id),
    );
    const toVerify = ranked.slice(0, MAX_VERIFY);

    const scored: ScoredCandidate[] = [];
    const unverified: Array<SearchChannelHit & { seen: number }> = [];
    for (const c of toVerify) {
      const recent = await fetchRecentVideos(c.channel_id);
      if (recent === null) {
        unverified.push(c);
        continue;
      }
      const evaluation = evaluateChannelCandidate(recent);
      scored.push({
        channelId: c.channel_id,
        channelName: c.channel_name,
        seenCount: c.seen,
        evaluation,
      });
      await new Promise((rs) => setTimeout(rs, 60));
    }

    // not-clean = quota degrade 또는 비-quota 검색 오류. 이런 run은 활성화도·clean
    // shadow 승격 카운트도 오염시키지 않는다(삼순 2번). DB degraded 컬럼에 이 broad 의미로 저장.
    const notClean = quotaDegraded || searchErrorCount > 0;

    // 6. mode 결정 — 완료된 non-degraded shadow 2회 전까지 shadow (오류 시 fail-closed)
    const { count: cleanShadow, error: cntErr } = await supabaseAdmin
      .from("channel_discovery_runs")
      .select("id", { count: "exact", head: true })
      .eq("mode", "shadow")
      .eq("status", "success")
      .eq("degraded", false);
    if (cntErr) throw new Error(`prior runs: ${cntErr.message}`);
    const mode = decideMode(cleanShadow ?? 0);

    // 활성화 대상: active 모드 그리고 not-clean이 아닐 때만(하드 게이트 — degraded/error run은
    // channel_pool 변경 0). 이후 커밋 RPC가 pool 반영+후보로그+run 마감을 원자적으로 처리.
    const activations =
      mode === "active" && !notClean ? pickActivations(scored, MAX_ACTIVATIONS) : [];
    const activateIds = new Set(activations.map((a) => a.channelId));
    const activated = activations.length;

    // 후보별 판정 로그 (run_id는 RPC가 설정 — 여기서는 미포함)
    const candLogs: Array<Record<string, unknown>> = scored.map((s) => {
      let decision: string;
      let reason: string = s.evaluation.reason;
      if (mode === "shadow") {
        decision = s.evaluation.pass ? "shadow_pass" : "shadow_fail";
      } else if (activateIds.has(s.channelId)) {
        decision = "activated";
      } else {
        decision = "rejected"; // 게이트 탈락 / 한도 초과 / degraded run 활성화 생략
        if (s.evaluation.pass) {
          reason = notClean
            ? `degraded/error run — 활성화 생략: ${s.evaluation.reason}`
            : `한도 초과(top ${MAX_ACTIVATIONS} 밖): ${s.evaluation.reason}`;
        }
      }
      return {
        channel_id: s.channelId,
        channel_name: s.channelName,
        seen_count: s.seenCount,
        decision,
        reason,
        kbo_count: s.evaluation.kboCount,
        kbo_considered: s.evaluation.considered,
        short_count: s.evaluation.shortCount,
        recent_upload_at: s.evaluation.recentUploadAt,
      };
    });
    for (const u of unverified) {
      candLogs.push({
        channel_id: u.channel_id,
        channel_name: u.channel_name,
        seen_count: u.seen,
        decision: "unverified",
        reason: "최근 영상 조회 실패(RSS/API)",
        kbo_count: null,
        kbo_considered: null,
        short_count: null,
        recent_upload_at: null,
      });
    }

    const passCount = scored.filter((s) => s.evaluation.pass).length;
    const degradeNote = quotaDegraded
      ? " DEGRADE=quota"
      : searchErrorCount > 0
        ? ` DEGRADE=search-err(${searchErrorCount})`
        : "";
    const summary =
      `mode=${mode} queries=${queries.length} candidates=${candidatesFound} ` +
      `verified=${scored.length} pass=${passCount} activated=${activated}` +
      ` quota≈${quotaUsed}${degradeNote}`;

    // 원자적 커밋 — run insert + channel_pool 활성화 + 후보로그를 단일 트랜잭션으로(삼순 1번).
    // 실패하면 전부 롤백 → 채널만 active인데 run/감사로그 없는 부분 커밋 상태 불가.
    const { data: commitData, error: commitErr } = await supabaseAdmin.rpc(
      "commit_channel_discovery",
      {
        p_mode: mode,
        p_queries: queries,
        p_candidates_found: candidatesFound,
        p_verified: scored.length,
        p_quota_used: quotaUsed,
        p_degraded: notClean,
        p_activated: activated,
        p_summary: summary,
        p_activations: activations.map((a) => ({
          channel_id: a.channelId,
          channel_name: a.channelName || a.channelId,
        })),
        p_candidates: candLogs,
      },
    );
    if (commitErr) throw new Error(`commit: ${commitErr.message}`);
    // RPC 반환 = {run_id, activated(actual)} — TOCTOU conflict 로 스킵된 건 제외한 실제 활성화 수.
    const commitRow = Array.isArray(commitData) ? commitData[0] : commitData;
    runId = commitRow?.run_id != null ? Number(commitRow.run_id) : null;
    const activatedActual =
      commitRow?.activated != null ? Number(commitRow.activated) : activated;
    // 시도 대비 실제가 적으면(스냅샷 이후 pool 에 이미 존재) 관측을 위해 경고 로그.
    if (activatedActual < activated) {
      console.warn(
        `[discover-channels] activated ${activated}→${activatedActual} (conflict skip ${activated - activatedActual}건: 스냅샷 이후 channel_pool 존재/운영자 비활성화)`,
      );
    }

    await finishJob(logId, notClean ? "warning" : "success", summary);

    return NextResponse.json({
      ok: true,
      runId,
      mode,
      queries,
      candidatesFound,
      verified: scored.length,
      pass: passCount,
      activated: activatedActual,
      activatedAttempted: activated,
      degraded: notClean,
      quotaDegraded,
      searchErrors: searchErrorCount,
      quotaEstimate: quotaUsed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 원자적 커밋 RPC 전에 실패했으면 run이 아예 없음(오팔 없음). 커밋 이후 실패만
    // runId가 설정되는데, 그 때는 이미 전체 트랜잭션이 커밋된 상태라 버려둑(finishJob만 기록).
    await finishJob(logId, "error", undefined, msg.slice(0, 900));
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    // lock 해제 (다음 실행이 stale 대기 안 하도록)
    await supabaseAdmin
      .from("channel_discovery_lock")
      .update({ locked_at: null })
      .eq("id", 1);
  }
}
