/**
 * Shorts Aggregator: RSS 수집 cron (channel_pool 전체, quota 0)
 *
 * 기존 B안 Phase 1 cron을 확장:
 *   - 10개 공식채널 → channel_pool 전체 (공식 + 비공식)
 *   - source_type: official_long/short + community_long/short
 *   - 선수 자동 태깅 (player-tagger)
 *   - 병렬 fetch (concurrency 제어)
 *
 * 스케줄: vercel.json crons (기존 6시간 → 향후 30분으로 단축 예정)
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

const CRON_SECRET = process.env.CRON_SECRET || "";
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
  let totalUpserted = 0;

  // Process in batches for concurrency control
  for (let i = 0; i < channels.length; i += CONCURRENCY) {
    const batch = channels.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (ch) => {
        const entries = await fetchChannelRss(ch.channel_id);
        const isOfficial = OFFICIAL_CHANNEL_IDS.has(ch.channel_id);
        const teamId = ch.team_affinity?.[0] ?? "ETC";

        const rows: VideoUpsertRow[] = entries.map((e) => {
          const noiseFlags = extractNoiseFlags(e.title, e.channel);
          const isShort = isShortCandidate({ title: e.title });
          const playerIds = matchPlayers(e.title, playerAliases);

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
            duration_seconds: null,
            source_type: sourceType,
            is_short_candidate: isShort,
            noise_flags: noiseFlags,
          };
        });

        return { channelName: ch.channel_name, rows };
      }),
    );

    for (const result of settled) {
      if (result.status === "rejected") {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors[`batch_${i}`] = msg;
        continue;
      }
      const { channelName, rows } = result.value;
      const { upserted, error } = await upsertVideos(supabaseAdmin, rows);
      if (error) {
        errors[channelName] = error;
      } else {
        results[channelName] = upserted;
        totalUpserted += upserted;
      }
    }
  }

  // Update last_video_at for channels that returned results
  const channelNames = Object.keys(results);
  if (channelNames.length > 0) {
    await supabaseAdmin
      .from("channel_pool")
      .update({ last_video_at: new Date().toISOString() })
      .in("channel_name", channelNames);
  }

  const errorCount = Object.keys(errors).length;
  const okCount = Object.keys(results).length;
  const status: "success" | "error" = errorCount === 0 ? "success" : "error";
  const summary = `channels=${channels.length} upserted=${totalUpserted} ok=${okCount} err=${errorCount}`;
  const errorMessage = errorCount > 0 ? JSON.stringify(errors).slice(0, 900) : undefined;

  await finishJob(logId, status, summary, errorMessage);

  return NextResponse.json({
    ok: errorCount === 0,
    status,
    channelsTotal: channels.length,
    totalUpserted,
    results,
    errors: errorCount > 0 ? errors : undefined,
  });
}
