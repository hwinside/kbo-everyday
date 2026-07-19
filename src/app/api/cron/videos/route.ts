/**
 * Shorts Aggregator: RSS 수집 cron (channel_pool 전체, quota 0)
 *
 * 기존 B안 Phase 1 cron을 확장:
 *   - 10개 공식채널 → channel_pool 전체 (공식 + 비공식)
 *   - source_type: official_long/short + community_long/short
 *   - 선수 자동 태깅 (player-tagger)
 *   - 병렬 fetch (concurrency 제어)
 *
 * 스케줄: vercel.json crons - 매 2시간 (15 every-2h)
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import {
  OFFICIAL_CHANNEL_IDS,
  getActiveChannels,
  type PoolChannel,
} from "@/lib/video/team-channels";
import { fetchChannelRss, type RssVideoEntry } from "@/lib/video/rss-parser";
import {
  extractNoiseFlags,
  isShortCandidate,
} from "@/lib/video/noise-flags";
import { upsertVideos, type VideoUpsertRow } from "@/lib/video/videos-repo";
import {
  loadPlayerAliases,
  matchPlayers,
  type PlayerAlias,
} from "@/lib/video/player-tagger";
import { detectTeamFromTitle } from "@/lib/video/team-detector";
import {
  fetchChannelUploadsViaApi,
  fetchVideoDurations,
} from "@/lib/video/youtube-api";
import { reserveQuota } from "@/lib/video/youtube-quota";

const CRON_SECRET = process.env.CRON_SECRET || "";
const BACKFILL_LIMIT = 500; // max videos to backfill per run
const BACKFILL_WINDOW_DAYS = 7;
const CONCURRENCY = 10;
// Cap fallback API calls per cron run. Worst-case spend = CAP * runs/day.
// Default 100 = 1200 quota units/day (12% of default 10k quota).
const FALLBACK_CAP = Number(process.env.YT_RSS_FALLBACK_PER_RUN ?? 100);

export const maxDuration = 60;

/**
 * Normalize fetched entries (RSS or playlistItems) into upsert rows.
 * Source-agnostic: both fetchers return the same `RssVideoEntry` shape.
 */
function entriesToRows(
  entries: RssVideoEntry[],
  ch: PoolChannel,
  playerAliases: PlayerAlias[],
): VideoUpsertRow[] {
  const isOfficial = OFFICIAL_CHANNEL_IDS.has(ch.channel_id);
  const channelTeam = ch.team_affinity?.[0] ?? null;

  return entries.map((e) => {
    const noiseFlags = extractNoiseFlags(e.title, e.channel);
    const isShort = isShortCandidate({ title: e.title });
    // Precision 매칭: 공식 채널은 channelTeam, T1은 선수명 only 허용, T2+는 팀명+선수명 필수
    const playerIds = matchPlayers(
      e.title,
      playerAliases,
      isOfficial ? channelTeam : null,
      isOfficial ? null : ch.tier,
    );
    // team_id: 채널 팀 > 매칭된 선수의 소속팀 > 제목 감지 > ETC
    // 선수 소속팀 우선 → 대전 영상에서 상대팀으로 잘못 잡히는 것 방지
    let teamId = channelTeam;
    if (!teamId && playerIds.length > 0) {
      const firstPlayer = playerAliases.find((p) => p.kbo_id === playerIds[0]);
      teamId = firstPlayer?.team ?? null;
    }
    if (!teamId) teamId = detectTeamFromTitle(e.title);

    const sourceType: VideoUpsertRow["source_type"] = isOfficial
      ? isShort ? "official_short" : "official_long"
      : isShort ? "community_short" : "community_long";

    return {
      video_id: e.video_id,
      team_id: teamId,
      player_id: playerIds[0] ?? null,
      player_ids: playerIds,
      title: e.title,
      channel: e.channel,
      channel_id: e.channel_id,
      thumbnail: e.thumbnail,
      published_at: e.published_at,
      source_type: sourceType,
      is_short_candidate: isShort,
      noise_flags: noiseFlags,
    };
  });
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const logId = await startJob("videos-rss");

  // Load channel pool + player aliases in parallel
  const [channels, playerAliases] = await Promise.all([
    getActiveChannels(supabaseAdmin),
    loadPlayerAliases(supabaseAdmin),
  ]);

  if (channels.length === 0) {
    await finishJob(logId, "error", undefined, "No active channels in channel_pool");
    return NextResponse.json({ error: "No channels" }, { status: 500 });
  }

  const results: Record<string, number> = {};
  const errors: Record<string, string> = {};
  const channelLatest = new Map<string, string>(); // channel_id → latest published_at
  const rssFailedChannels: PoolChannel[] = []; // for fallback (preserves tier order)
  let totalUpserted = 0;

  const errorKey = (ch: PoolChannel) => `${ch.channel_name}(${ch.channel_id})`;

  // Process in batches for concurrency control
  for (let i = 0; i < channels.length; i += CONCURRENCY) {
    const batch = channels.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (ch) => ({
        ch,
        rows: entriesToRows(await fetchChannelRss(ch.channel_id), ch, playerAliases),
      })),
    );

    for (let j = 0; j < settled.length; j++) {
      const result = settled[j];
      const ch = batch[j];
      if (result.status === "rejected") {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors[errorKey(ch)] = msg;
        rssFailedChannels.push(ch);
        continue;
      }
      const { rows } = result.value;
      const { upserted, error } = await upsertVideos(supabaseAdmin, rows);
      if (error) {
        errors[errorKey(ch)] = error;
        // upsert failure is not an RSS-fetch failure → don't fallback
      } else {
        results[ch.channel_name] = upserted;
        totalUpserted += upserted;
        // Track latest published_at per channel for last_video_at
        if (rows.length > 0) {
          const latest = rows.reduce((a, b) =>
            a.published_at > b.published_at ? a : b
          ).published_at;
          channelLatest.set(ch.channel_id, latest);
        }
      }
    }
  }

  // ── Fallback: playlistItems.list for RSS-failed channels (capped per run) ──
  // YouTube blocks RSS from datacenter IPs (Vercel) intermittently. When that
  // happens we re-fetch via Data API. Tier 1 (official) channels are processed
  // first because getActiveChannels orders by tier asc.
  //
  // Three fallback outcomes — distinct so operators can spot dead/silent channels:
  //   recovered  : API returned rows that we upserted → erase original RSS error
  //   noUploads  : API returned [] (200 empty or 404) → channel is alive in DB
  //                but produces nothing right now. Keep RSS error annotated so
  //                operators can decide whether to flip is_active=false later.
  //   failed     : API call itself failed (network, all keys 403, upsert error)
  //                → leave RSS error in place, soft-warn via counter.
  let fallbackRecovered = 0;
  let fallbackNoUploads = 0;
  let fallbackFailed = 0;
  let fallbackQuotaUsed = 0;
  let fallbackLedgerSkipped = 0;
  let ledgerErr: string | undefined; // 원장 RPC 장애(백스톱 진행하되 warning 노출)
  const fallbackTargets = rssFailedChannels.slice(0, FALLBACK_CAP);
  for (const ch of fallbackTargets) {
    // 공유 원장 예약(playlistItems.list = 1 unit). 잔여 없으면 fallback 중단.
    const reservation = await reserveQuota(supabaseAdmin, 1);
    if (reservation.ledgerError && !ledgerErr) ledgerErr = reservation.ledgerError;
    if (!reservation.allowed) {
      fallbackLedgerSkipped = fallbackTargets.length - fallbackQuotaUsed;
      break;
    }
    fallbackQuotaUsed++;
    const entries = await fetchChannelUploadsViaApi(ch.channel_id);
    if (entries === null) {
      fallbackFailed++;
      // keep original RSS error in errors[errorKey(ch)]
      continue;
    }
    if (entries.length === 0) {
      fallbackNoUploads++;
      const prev = errors[errorKey(ch)] ?? "";
      errors[errorKey(ch)] = `${prev} | [fallback: no uploads via API]`;
      continue;
    }
    const rows = entriesToRows(entries, ch, playerAliases);
    const { upserted, error } = await upsertVideos(supabaseAdmin, rows);
    if (error) {
      fallbackFailed++;
      errors[errorKey(ch)] = `[fallback upsert] ${error}`;
      continue;
    }
    delete errors[errorKey(ch)];
    results[ch.channel_name] = upserted;
    totalUpserted += upserted;
    fallbackRecovered++;
    const latest = rows.reduce((a, b) =>
      a.published_at > b.published_at ? a : b,
    ).published_at;
    channelLatest.set(ch.channel_id, latest);
  }

  // Update last_video_at per channel with actual latest published_at
  for (const [chId, latestAt] of channelLatest) {
    await supabaseAdmin
      .from("channel_pool")
      .update({ last_video_at: latestAt })
      .eq("channel_id", chId);
  }

  // ── Duration backfill: fetch from YouTube API for NULL-duration videos ──
  let backfilled = 0;
  let backfillApiCalls = 0;
  let backfillLedgerSkipped = false;
  try {
    const cutoff = new Date(Date.now() - BACKFILL_WINDOW_DAYS * 86_400_000).toISOString();
    const { data: nullRows } = await supabaseAdmin
      .from("videos")
      .select("video_id, source_type")
      .is("duration_seconds", null)
      .gte("published_at", cutoff)
      .limit(BACKFILL_LIMIT);

    if (nullRows && nullRows.length > 0) {
      const ids = nullRows.map((r: { video_id: string }) => r.video_id);
      backfillApiCalls = Math.ceil(ids.length / 50);
      // 공유 원장 예약(videos.list = 1 unit/call). 잔여 부족이면 backfill 생략.
      const reservation = await reserveQuota(supabaseAdmin, backfillApiCalls);
      if (reservation.ledgerError && !ledgerErr) ledgerErr = reservation.ledgerError;
      if (!reservation.allowed) {
        backfillLedgerSkipped = true;
        throw new Error("quota ledger cap — backfill skipped");
      }
      const durations = await fetchVideoDurations(ids);

      // Build lookup for source_type
      const sourceMap = new Map(
        nullRows.map((r: { video_id: string; source_type: string }) => [r.video_id, r.source_type]),
      );

      // Batch updates (concurrency 20)
      const updates: PromiseLike<unknown>[] = [];
      for (const [videoId, duration] of durations) {
        const isShort = duration > 0 && duration <= 70;
        const existing = sourceMap.get(videoId) ?? "community_long";
        let newSourceType = existing;
        if (isShort) {
          if (existing === "official_long") newSourceType = "official_short";
          else if (existing === "community_long") newSourceType = "community_short";
        } else {
          if (existing === "official_short") newSourceType = "official_long";
          else if (existing === "community_short") newSourceType = "community_long";
        }

        updates.push(
          supabaseAdmin
            .from("videos")
            .update({
              duration_seconds: duration,
              is_short_candidate: isShort,
              source_type: newSourceType,
            })
            .eq("video_id", videoId)
            .then(),
        );

        // Flush in batches of 20
        if (updates.length >= 20) {
          await Promise.all(updates.splice(0));
        }
      }
      if (updates.length > 0) await Promise.all(updates);
      backfilled = durations.size;
    }
  } catch {
    // Duration backfill is best-effort — don't fail the cron
  }

  // fallback/backfill quota는 reserveQuota가 이미 원장에 반영함(이중 기록 방지로 record 생략).
  const errorCount = Object.keys(errors).length;
  const okCount = Object.keys(results).length;
  // Partial-success is "warning", not "error". The anomaly detector
  // (lib/admin/anomaly.ts) only triggers on consecutive "error" runs, so a
  // handful of dead channels no longer false-alarms when the bulk succeeded.
  // ledger skip/장애는 성공으로 숨지 않고 warning으로 들어올린다(삼순 3번).
  const ledgerDegraded = fallbackLedgerSkipped > 0 || backfillLedgerSkipped || !!ledgerErr;
  const status: "success" | "warning" | "error" =
    errorCount > 0 && okCount === 0
      ? "error"
      : errorCount > 0 || ledgerDegraded
        ? "warning"
        : "success";
  const summary =
    `channels=${channels.length} upserted=${totalUpserted} ` +
    `ok=${okCount} err=${errorCount} ` +
    `fallback=recovered:${fallbackRecovered}/no_uploads:${fallbackNoUploads}/failed:${fallbackFailed}` +
    `(quota=${fallbackQuotaUsed}${fallbackLedgerSkipped > 0 ? `,ledgerSkip:${fallbackLedgerSkipped}` : ""}) ` +
    `backfilled=${backfilled}${backfillLedgerSkipped ? "(ledger-skip)" : ""} apiCalls=${backfillApiCalls}` +
    `${ledgerErr ? ` LEDGER_ERR=${ledgerErr.slice(0, 60)}` : ""}`;
  const errorMessage =
    errorCount > 0
      ? JSON.stringify(errors).slice(0, 900)
      : ledgerErr
        ? `quota ledger unavailable (${ledgerErr.slice(0, 120)}) — ran without shared cap, warning`
        : undefined;

  await finishJob(logId, status, summary, errorMessage);

  return NextResponse.json({
    ok: errorCount === 0,
    status,
    channelsTotal: channels.length,
    totalUpserted,
    backfilled,
    backfillApiCalls,
    fallback: {
      attempted: fallbackQuotaUsed,
      recovered: fallbackRecovered,
      noUploads: fallbackNoUploads,
      failed: fallbackFailed,
      capped: rssFailedChannels.length > FALLBACK_CAP
        ? rssFailedChannels.length - FALLBACK_CAP
        : 0,
    },
    results,
    errors: errorCount > 0 ? errors : undefined,
  });
}
