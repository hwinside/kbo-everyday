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
  // When team is specified AND player_ids are present, include community/ETC videos
  // that match the user's favorite players — this is the core feature:
  // "선수 관련 숏츠는 공식이 아니어도 다 보여준다"
  const selectCols = "video_id, title, thumbnail, channel, channel_id, published_at, source_type, player_id, player_ids, noise_flags, team_id";
  const fetchLimit = limit * 3;

  let data: any[] | null = null;
  let error: any = null;

  if (team !== "_ALL" && playerIds.length > 0) {
    // Two queries: team-scoped + player-matched from any team (including ETC)
    const [teamResult, playerResult] = await Promise.all([
      supabaseAdmin
        .from("videos")
        .select(selectCols)
        .eq("is_short_candidate", true)
        .eq("team_id", team)
        .order("published_at", { ascending: false })
        .limit(fetchLimit),
      supabaseAdmin
        .from("videos")
        .select(selectCols)
        .eq("is_short_candidate", true)
        .overlaps("player_ids", playerIds)
        .order("published_at", { ascending: false })
        .limit(fetchLimit),
    ]);

    error = teamResult.error || playerResult.error;
    if (!error) {
      // Merge and deduplicate
      const seen = new Set<string>();
      const merged: any[] = [];
      for (const v of [...(teamResult.data ?? []), ...(playerResult.data ?? [])]) {
        if (!seen.has(v.video_id)) {
          seen.add(v.video_id);
          merged.push(v);
        }
      }
      data = merged;
    }
  } else {
    const query = supabaseAdmin
      .from("videos")
      .select(selectCols)
      .eq("is_short_candidate", true)
      .order("published_at", { ascending: false })
      .limit(fetchLimit);

    if (team !== "_ALL") {
      query.eq("team_id", team);
    }

    const result = await query;
    data = result.data;
    error = result.error;
  }

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
    teamId: v.team_id ?? null,
  }));

  // Sort: favorite player matches FIRST (강한 개인화), then recency
  const playerIdSet = new Set(playerIds);
  if (playerIdSet.size > 0) {
    // Partition: player-matched items go to front, rest to back
    const playerMatched: typeof items = [];
    const rest: typeof items = [];
    for (const item of items) {
      if (item.playerIds.some((id: string) => playerIdSet.has(id))) {
        playerMatched.push(item);
      } else {
        rest.push(item);
      }
    }
    // Each group sorted by recency
    const byRecency = (a: typeof items[0], b: typeof items[0]) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    playerMatched.sort(byRecency);
    rest.sort(byRecency);
    items.length = 0;
    items.push(...playerMatched, ...rest);
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
