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
import { DEFAULT_EXCLUDE_FLAGS, extractNoiseFlags } from "@/lib/video/noise-flags";
import { loadPlayerAliases } from "@/lib/video/player-tagger";
import { isTeamShortRelevant } from "@/lib/video/shorts-relevance";
import { getActiveChannels } from "@/lib/video/team-channels";

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

  // Time window: only shorts from last 7 days
  const sinceDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch shorts candidates, over-fetch for post-filtering
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
        .gte("published_at", sinceDate)
        .order("published_at", { ascending: false })
        .limit(fetchLimit),
      supabaseAdmin
        .from("videos")
        .select(selectCols)
        .eq("is_short_candidate", true)
        .overlaps("player_ids", playerIds)
        .gte("published_at", sinceDate)
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
      .gte("published_at", sinceDate)
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

  // 검증 야구채널 신호(channel_pool tier 1 방송사/공식급 또는 해당 팀 affinity)를
  // LG 야구 문맥 긍정 근거로 전달 (2026-07-24 삼순 라운드3 A안 —
  // TVING `한화 vs LG` 팬덤중계류 recall 보존, 출처 불명 채널 제품 비교는 차단).
  // (LG 행이 있을 때만 조회 — 다른 팀 피드에 불필요한 쿼리 방지)
  let trustedForLg: ReadonlySet<string> = new Set();
  if ((data ?? []).some((v) => v.team_id === "LG")) {
    const poolChannels = await getActiveChannels(supabaseAdmin);
    trustedForLg = new Set(
      poolChannels
        .filter((c) => c.tier === 1 || c.team_affinity?.includes("LG"))
        .map((c) => c.channel_id),
    );
  }

  // Filter out noisy content — DB flags + runtime title recheck
  // Runtime recheck catches videos ingested before new noise patterns were added
  const excludeSet = DEFAULT_EXCLUDE_FLAGS as ReadonlySet<string>;
  const filtered = (data ?? []).filter((v) => {
    const flags: string[] = Array.isArray(v.noise_flags) ? v.noise_flags : [];
    if (flags.some((f) => excludeSet.has(f))) return false;
    // 기존 오분류 행도 즉시 차단: LG 약칭만 걸린 커뮤니티 영상은 야구 문맥 필수
    if (!isTeamShortRelevant(v.title ?? "", v.team_id ?? null, {
      hasPlayerTag: Boolean(v.player_id || v.player_ids?.length),
      isOfficial: String(v.source_type ?? "").startsWith("official_"),
      trustedChannel: Boolean(v.channel_id && trustedForLg.has(v.channel_id)),
    })) return false;
    // Runtime title recheck for patterns added after ingestion
    const runtimeFlags = extractNoiseFlags(v.title, v.channel);
    return !runtimeFlags.some((f) => excludeSet.has(f as string));
  });

  // Build player_id → name map for tagged videos
  const taggedPlayerIds = new Set<string>();
  for (const v of filtered) {
    if (v.player_id) taggedPlayerIds.add(v.player_id);
  }
  let playerNameMap = new Map<string, string>();
  if (taggedPlayerIds.size > 0) {
    const aliases = await loadPlayerAliases(supabaseAdmin);
    for (const a of aliases) {
      if (taggedPlayerIds.has(a.kbo_id)) {
        playerNameMap.set(a.kbo_id, a.name);
      }
    }
  }

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
    playerName: v.player_id ? (playerNameMap.get(v.player_id) ?? null) : null,
  }));

  // Sort: player-matched items interleaved by player (round-robin), then team videos
  const playerIdSet = new Set(playerIds);
  if (playerIdSet.size > 0) {
    // Group by matched player (first match wins)
    const byPlayer = new Map<string, typeof items>();
    const rest: typeof items = [];
    for (const item of items) {
      const matchedId = item.playerIds.find((id: string) => playerIdSet.has(id));
      if (matchedId) {
        const bucket = byPlayer.get(matchedId);
        if (bucket) bucket.push(item);
        else byPlayer.set(matchedId, [item]);
      } else {
        rest.push(item);
      }
    }

    // Sort each player bucket by recency
    const byRecency = (a: typeof items[0], b: typeof items[0]) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    for (const bucket of byPlayer.values()) bucket.sort(byRecency);
    rest.sort(byRecency);

    // Recency-weighted round-robin: always pick the player whose next video is most recent
    // This ensures today's videos come before yesterday's while still interleaving players
    const interleaved: typeof items = [];
    const buckets = Array.from(byPlayer.values());
    const indices = new Array(buckets.length).fill(0);
    let lastPickedBucket = -1;

    while (interleaved.length < items.length) {
      let bestBucket = -1;
      let bestTime = -Infinity;

      for (let b = 0; b < buckets.length; b++) {
        if (indices[b] >= buckets[b].length) continue;
        // Skip same bucket twice in a row (diversity guarantee)
        if (b === lastPickedBucket && buckets.length > 1) {
          const othersAvailable = buckets.some((_, i) => i !== b && indices[i] < buckets[i].length);
          if (othersAvailable) continue;
        }
        const t = new Date(buckets[b][indices[b]].publishedAt).getTime();
        if (t > bestTime) { bestTime = t; bestBucket = b; }
      }

      if (bestBucket === -1) break;
      interleaved.push(buckets[bestBucket][indices[bestBucket]++]);
      lastPickedBucket = bestBucket;
    }

    items.length = 0;
    items.push(...interleaved, ...rest);
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
