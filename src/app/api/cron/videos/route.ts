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
import { OFFICIAL_CHANNEL_IDS, getActiveChannels } from "@/lib/video/team-channels";
import { fetchChannelRss } from "@/lib/video/rss-parser";
import {
  extractNoiseFlags,
  isShortCandidate,
} from "@/lib/video/noise-flags";
import { upsertVideos, type VideoUpsertRow } from "@/lib/video/videos-repo";
import { loadPlayerAliases, matchPlayers } from "@/lib/video/player-tagger";
import { detectTeamFromTitle } from "@/lib/video/team-detector";
import { fetchVideoDurations } from "@/lib/video/youtube-api";

const CRON_SECRET = process.env.CRON_SECRET || "";
const BACKFILL_LIMIT = 500; // max videos to backfill per run
const BACKFILL_WINDOW_DAYS = 7;
const CONCURRENCY = 10;

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
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
  let totalUpserted = 0;

  // Process in batches for concurrency control
  for (let i = 0; i < channels.length; i += CONCURRENCY) {
    const batch = channels.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (ch) => {
        const entries = await fetchChannelRss(ch.channel_id);
        const isOfficial = OFFICIAL_CHANNEL_IDS.has(ch.channel_id);
        const channelTeam = ch.team_affinity?.[0] ?? null;

        const rows: VideoUpsertRow[] = entries.map((e) => {
          const noiseFlags = extractNoiseFlags(e.title, e.channel);
          const isShort = isShortCandidate({ title: e.title });
          // Precision 매칭: 공식 채널은 channelTeam, T1은 선수명 only 허용, T2+는 팀명+선수명 필수
          const playerIds = matchPlayers(e.title, playerAliases, isOfficial ? channelTeam : null, isOfficial ? null : ch.tier);
          // team_id: 채널 팀 > 매칭된 선수의 소속팀 > 제목 감지 > ETC
          // 선수 소속팀 우선 → 대전 영상에서 상대팀으로 잘못 잡히는 것 방지
          let teamId = channelTeam;
          if (!teamId && playerIds.length > 0) {
            const firstPlayer = playerAliases.find((p) => p.kbo_id === playerIds[0]);
            teamId = firstPlayer?.team ?? null;
          }
          if (!teamId) teamId = detectTeamFromTitle(e.title);

          let sourceType: VideoUpsertRow["source_type"];
          if (isOfficial) {
            sourceType = isShort ? "official_short" : "official_long";
          } else {
            sourceType = isShort ? "community_short" : "community_long";
          }

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

        return { channelId: ch.channel_id, channelName: ch.channel_name, rows };
      }),
    );

    for (let j = 0; j < settled.length; j++) {
      const result = settled[j];
      if (result.status === "rejected") {
        const ch = batch[j];
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors[`${ch.channel_name}(${ch.channel_id})`] = msg;
        continue;
      }
      const { channelId, channelName, rows } = result.value;
      const { upserted, error } = await upsertVideos(supabaseAdmin, rows);
      if (error) {
        errors[channelName] = error;
      } else {
        results[channelName] = upserted;
        totalUpserted += upserted;
        // Track latest published_at per channel for last_video_at
        if (rows.length > 0) {
          const latest = rows.reduce((a, b) =>
            a.published_at > b.published_at ? a : b
          ).published_at;
          channelLatest.set(channelId, latest);
        }
      }
    }
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

  const errorCount = Object.keys(errors).length;
  const okCount = Object.keys(results).length;
  const status: "success" | "error" = errorCount === 0 ? "success" : "error";
  const summary = `channels=${channels.length} upserted=${totalUpserted} ok=${okCount} err=${errorCount} backfilled=${backfilled} apiCalls=${backfillApiCalls}`;
  const errorMessage = errorCount > 0 ? JSON.stringify(errors).slice(0, 900) : undefined;

  await finishJob(logId, status, summary, errorMessage);

  return NextResponse.json({
    ok: errorCount === 0,
    status,
    channelsTotal: channels.length,
    totalUpserted,
    backfilled,
    backfillApiCalls,
    results,
    errors: errorCount > 0 ? errors : undefined,
  });
}
