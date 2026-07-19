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
    let degraded = false;
    for (const q of queries) {
      const r = await searchChannels(q);
      if (r.quota) {
        degraded = true;
        break; // fail-closed: 이후 검색 중단
      }
      if (r.error) {
        // 비-quota 단건 오류는 스킵하고 다음 쿼리 진행
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

    // 6. mode 결정 — 완료된 non-degraded shadow 2회 전까지 shadow (오류 시 fail-closed)
    const { count: cleanShadow, error: cntErr } = await supabaseAdmin
      .from("channel_discovery_runs")
      .select("id", { count: "exact", head: true })
      .eq("mode", "shadow")
      .eq("status", "success")
      .eq("degraded", false);
    if (cntErr) throw new Error(`prior runs: ${cntErr.message}`);
    const mode = decideMode(cleanShadow ?? 0);

    // run 로그 선삽입(status=running, 후보 로그 FK)
    const { data: runRow, error: runErr } = await supabaseAdmin
      .from("channel_discovery_runs")
      .insert({
        mode,
        status: "running",
        queries,
        candidates_found: candidatesFound,
        verified: scored.length,
        quota_used: quotaUsed,
        degraded,
      })
      .select("id")
      .single();
    if (runErr || !runRow) throw new Error(`run insert: ${runErr?.message ?? "no row"}`);
    runId = runRow.id as number;

    // active 모드: channel_pool 활성화를 먼저 반영(성공해야 'activated' 로그 기록 — 원자성)
    const activations = pickActivations(scored, MAX_ACTIVATIONS);
    const activateIds = new Set<string>();
    let activated = 0;
    if (mode === "active" && activations.length > 0) {
      const rows = activations.map((a) => ({
        channel_id: a.channelId,
        channel_name: a.channelName || a.channelId,
        tier: 3,
        is_active: true,
        team_affinity: null as string[] | null,
      }));
      const { error: upErr } = await supabaseAdmin
        .from("channel_pool")
        .upsert(rows, { onConflict: "channel_id" });
      if (upErr) throw new Error(`channel_pool upsert: ${upErr.message}`);
      for (const a of activations) activateIds.add(a.channelId);
      activated = rows.length;
    }

    // 후보별 판정 로그 (pool 반영 이후라 activated 결정이 실제 반영과 일치)
    const candLogs: Array<Record<string, unknown>> = scored.map((s) => {
      let decision: string;
      if (mode === "shadow") {
        decision = s.evaluation.pass ? "shadow_pass" : "shadow_fail";
      } else if (activateIds.has(s.channelId)) {
        decision = "activated";
      } else {
        decision = "rejected"; // 게이트 탈락 또는 활성 한도(5) 초과
      }
      return {
        run_id: runId,
        channel_id: s.channelId,
        channel_name: s.channelName,
        seen_count: s.seenCount,
        decision,
        reason:
          decision === "rejected" && s.evaluation.pass
            ? `한도 초과(top ${MAX_ACTIVATIONS} 밖): ${s.evaluation.reason}`
            : s.evaluation.reason,
        kbo_count: s.evaluation.kboCount,
        kbo_considered: s.evaluation.considered,
        short_count: s.evaluation.shortCount,
        recent_upload_at: s.evaluation.recentUploadAt,
      };
    });
    for (const u of unverified) {
      candLogs.push({
        run_id: runId,
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
    if (candLogs.length > 0) {
      const { error: logErr } = await supabaseAdmin
        .from("channel_discovery_candidates")
        .insert(candLogs);
      if (logErr) throw new Error(`candidate logs: ${logErr.message}`);
    }

    // run 마감 (성공) — 모든 DB 반영 성공 후에만 success 로 승격
    const passCount = scored.filter((s) => s.evaluation.pass).length;
    const summary =
      `mode=${mode} queries=${queries.length} candidates=${candidatesFound} ` +
      `verified=${scored.length} pass=${passCount} activated=${activated} ` +
      `quota≈${quotaUsed}${degraded ? " DEGRADE=quota" : ""}`;
    const { error: finErr } = await supabaseAdmin
      .from("channel_discovery_runs")
      .update({ activated, summary, status: "success" })
      .eq("id", runId);
    if (finErr) throw new Error(`run finalize: ${finErr.message}`);

    await finishJob(logId, degraded ? "warning" : "success", summary);

    return NextResponse.json({
      ok: true,
      mode,
      queries,
      candidatesFound,
      verified: scored.length,
      pass: passCount,
      activated,
      degraded,
      quotaEstimate: quotaUsed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // run 을 error 로 마킹 → shadow 승격 카운트에서 제외 (미완료 실행이 승격 오염 방지)
    if (runId) {
      await supabaseAdmin
        .from("channel_discovery_runs")
        .update({ status: "error", summary: msg.slice(0, 300) })
        .eq("id", runId);
    }
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
