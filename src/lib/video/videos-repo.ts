/**
 * `videos` 테이블 upsert 유틸 (cron 수집 전용)
 * B안 Phase 1
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NoiseFlag } from "./noise-flags";

export type VideoSourceType =
  | "official_long"
  | "official_short"
  | "player"
  | "team_search"
  | "community_short"
  | "community_long";

export interface VideoUpsertRow {
  video_id: string;
  team_id: string;
  player_id?: string | null;
  player_ids?: string[];
  title: string;
  channel?: string | null;
  channel_id?: string | null;
  thumbnail?: string | null;
  published_at: string; // ISO
  duration_seconds?: number | null;
  source_type: VideoSourceType;
  is_short_candidate: boolean;
  noise_flags: NoiseFlag[] | string[];
}

/**
 * videos 테이블 bulk upsert (video_id unique)
 * @returns { inserted, skipped, errors }
 */
export async function upsertVideos(
  supabase: SupabaseClient,
  rows: VideoUpsertRow[],
): Promise<{ upserted: number; error?: string }> {
  if (rows.length === 0) return { upserted: 0 };

  const payload = rows.map((r) => ({
    video_id: r.video_id,
    team_id: r.team_id,
    player_id: r.player_id ?? null,
    player_ids: r.player_ids ?? [],
    title: r.title,
    channel: r.channel ?? null,
    channel_id: r.channel_id ?? null,
    thumbnail: r.thumbnail ?? null,
    published_at: r.published_at,
    duration_seconds: r.duration_seconds ?? null,
    source_type: r.source_type,
    is_short_candidate: r.is_short_candidate,
    noise_flags: r.noise_flags,
    fetched_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("videos")
    .upsert(payload, { onConflict: "video_id" });

  if (error) {
    return { upserted: 0, error: error.message };
  }
  return { upserted: payload.length };
}
