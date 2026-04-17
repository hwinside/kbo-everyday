/**
 * B안 Phase 1: 10팀 공식 채널 RSS 기반 롱폼+숏츠 수집 (quota 0)
 *
 * 스케줄: vercel.json crons - 6시간마다 15분 (Vercel cron = UTC 기준)
 *   UTC 00:15 / 06:15 / 12:15 / 18:15
 *   KST 09:15 / 15:15 / 21:15 / 03:15 (+9h)
 *
 * - RSS 15개씩 최신 → 숏츠 후보는 is_short_candidate=true
 * - duration 없음 → source_type는 official_long 고정, 숏츠 여부는 flag로 구분
 *   (상세 duration은 Phase 1-b에서 별도 API로 보강 가능, 현재는 RSS만)
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import { TEAM_OFFICIAL_CHANNELS } from "@/lib/video/team-channels";
import { fetchChannelRss } from "@/lib/video/rss-parser";
import {
  extractNoiseFlags,
  isShortCandidate,
} from "@/lib/video/noise-flags";
import { upsertVideos, type VideoUpsertRow } from "@/lib/video/videos-repo";

const CRON_SECRET = process.env.CRON_SECRET || "";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const logId = await startJob("videos-rss");
  const results: Record<string, number> = {};
  const errors: Record<string, string> = {};
  let totalUpserted = 0;

  for (const [teamId, channelId] of Object.entries(TEAM_OFFICIAL_CHANNELS)) {
    try {
      const entries = await fetchChannelRss(channelId);
      const rows: VideoUpsertRow[] = entries.map((e) => {
        const noiseFlags = extractNoiseFlags(e.title, e.channel);
        const isShort = isShortCandidate({ title: e.title });
        return {
          video_id: e.video_id,
          team_id: teamId,
          player_id: null,
          title: e.title,
          channel: e.channel,
          channel_id: e.channel_id,
          thumbnail: e.thumbnail,
          published_at: e.published_at,
          duration_seconds: null,
          source_type: isShort ? "official_short" : "official_long",
          is_short_candidate: isShort,
          noise_flags: noiseFlags,
        };
      });

      const { upserted, error } = await upsertVideos(supabaseAdmin, rows);
      if (error) {
        errors[teamId] = error;
      } else {
        results[teamId] = upserted;
        totalUpserted += upserted;
      }
    } catch (err) {
      errors[teamId] = err instanceof Error ? err.message : String(err);
    }
  }

  const errorCount = Object.keys(errors).length;
  const okCount = Object.keys(results).length;
  const status: "success" | "error" = errorCount === 0 ? "success" : "error";
  const summary = `upserted=${totalUpserted} teams_ok=${okCount} teams_err=${errorCount}`;
  const errorMessage = errorCount > 0 ? JSON.stringify(errors).slice(0, 900) : undefined;

  await finishJob(logId, status, summary, errorMessage);

  return NextResponse.json({
    ok: errorCount === 0,
    status,
    totalUpserted,
    results,
    errors,
  });
}
