/**
 * Shorts feed API — serves shorts from videos table (quota 0)
 * Replaces runtime YouTube API calls for the shorts carousel.
 *
 * Query params:
 *   team     — team shortName (default: "_ALL")
 *   player_ids — comma-separated kbo_ids for favorite player prioritization
 *   limit    — max items (default: 30, max: 50)
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { DEFAULT_EXCLUDE_FLAGS } from "@/lib/video/noise-flags";

export async function GET(req: NextRequest) {
  const team = req.nextUrl.searchParams.get("team") || "_ALL";
  const playerIdsParam = req.nextUrl.searchParams.get("player_ids") || "";
  const playerIds = playerIdsParam
    ? playerIdsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const limit = Math.min(
    parseInt(req.nextUrl.searchParams.get("limit") || "30", 10),
    50,
  );

  // Fetch shorts candidates, over-fetch for post-filtering
  let query = supabaseAdmin
    .from("videos")
    .select("video_id, title, thumbnail, channel, channel_id, published_at, source_type, player_id, player_ids, noise_flags")
    .eq("is_short_candidate", true)
    .order("published_at", { ascending: false })
    .limit(limit * 3);

  if (team !== "_ALL") {
    query = query.eq("team_id", team);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Filter out noisy content in application code
  const excludeSet = DEFAULT_EXCLUDE_FLAGS as ReadonlySet<string>;
  const filtered = (data ?? []).filter((v) => {
    const flags: string[] = Array.isArray(v.noise_flags) ? v.noise_flags : [];
    return !flags.some((f) => excludeSet.has(f));
  });

  const items = filtered.map((v) => ({
    id: v.video_id,
    title: v.title,
    thumbnail: v.thumbnail,
    channel: v.channel,
    publishedAt: v.published_at,
    sourceType: v.source_type,
    playerId: v.player_id,
    playerIds: v.player_ids ?? [],
  }));

  // Sort: favorite player matches first, then recency
  const playerIdSet = new Set(playerIds);
  if (playerIdSet.size > 0) {
    items.sort((a, b) => {
      const aMatch = a.playerIds.some((id: string) => playerIdSet.has(id)) ? 1 : 0;
      const bMatch = b.playerIds.some((id: string) => playerIdSet.has(id)) ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
      return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    });
  }

  // Diversity: max 3 from same channel in a row
  const diversified: typeof items = [];
  let lastChannel = "";
  let streak = 0;

  for (const item of items) {
    if (diversified.length >= limit) break;
    const ch = item.channel ?? "unknown";
    if (ch === lastChannel) {
      streak++;
      if (streak > 3) continue;
    } else {
      lastChannel = ch;
      streak = 1;
    }
    diversified.push(item);
  }

  return NextResponse.json(
    { items: diversified },
    {
      headers: {
        "Cache-Control": "public, s-maxage=900, stale-while-revalidate=60",
      },
    },
  );
}
