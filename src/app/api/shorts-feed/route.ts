/**
 * Shorts feed API — serves shorts from videos table (quota 0)
 * Replaces runtime YouTube API calls for the shorts carousel.
 *
 * Query params:
 *   team     — team shortName (default: "_ALL")
 *   player_ids — comma-separated kbo_ids for favorite player prioritization
 *   limit    — max items (default: 30, max: 50)
 *   scope    — "favorite_players" | "my_team" | "all" (optional; 미지정 시 기존 혼합 피드)
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as productionSupabaseAdmin } from "@/lib/supabase/admin";
import {
  DEFAULT_EXCLUDE_FLAGS,
  extractNoiseFlags,
} from "@/lib/video/noise-flags";
import { loadPlayerAliases, type PlayerAlias } from "@/lib/video/player-tagger";
import { revalidateStoredPlayerTags } from "@/lib/video/shorts-player-gate";
import { isTeamShortRelevant } from "@/lib/video/shorts-relevance";
import { joinLgFeedRows } from "@/lib/video/shorts-feed-merge";
import {
  includesLgTeamFeed,
  parseShortsScope,
  resolveShortsQueryPlan,
} from "@/lib/video/shorts-feed-scope";
import {
  getPlayerTagChannels,
  type PlayerTagChannel,
} from "@/lib/video/team-channels";

type ShortsFeedDependencies = {
  supabase?: typeof productionSupabaseAdmin;
  loadAliases?: typeof loadPlayerAliases;
  loadChannels?: typeof getPlayerTagChannels;
  now?: () => number;
};

export async function handleShortsFeedGET(
  req: NextRequest,
  dependencies: ShortsFeedDependencies = {},
) {
  const supabaseAdmin = dependencies.supabase ?? productionSupabaseAdmin;
  const loadAliases = dependencies.loadAliases ?? loadPlayerAliases;
  const loadChannels = dependencies.loadChannels ?? getPlayerTagChannels;
  const now = dependencies.now ?? Date.now;
  const team = req.nextUrl.searchParams.get("team") || "_ALL";
  const playerIdsParam = req.nextUrl.searchParams.get("player_ids") || "";
  const playerIds = playerIdsParam
    ? playerIdsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const limit = Math.min(
    parseInt(req.nextUrl.searchParams.get("limit") || "30", 10),
    50,
  );
  const scope = parseShortsScope(req.nextUrl.searchParams.get("scope"));

  // Time window: only shorts from last 7 days
  const sinceDate = new Date(now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch shorts candidates, over-fetch for post-filtering
  const selectCols =
    "video_id, title, thumbnail, channel, channel_id, published_at, source_type, player_id, player_ids, noise_flags, team_id";
  const fetchLimit = limit * 3;

  let data: any[] | null = null;
  let error: any = null;

  const plan = resolveShortsQueryPlan(scope, team, playerIds.length);

  // 다중 팀 노출 (2026-07-24 삼순 라운드4 — 운영 케이스 79W-OwErIEA):
  // 비-LG affinity 채널(예: 히어로북, 키움)이 올린 명시적 LG 야구 제목은
  // 수집 계약(channelTeam 선확정)을 유지한 채 team_id가 LG가 아니므로,
  // team_id 선조회만으로는 LG 피드에서 영구 누락된다. 제목에 LG/엘지가
  // 들어간 비-LG 행을 역조회해 아래 detectAllTeamsFromTitle 경계 게이트
  // (독립 LG 언급 + 야구 문맥, SLG·기업 접미 오포집 차단)로 합류시킨다.
  // 기존 오분류/선확정 행에도 소급 적용되므로 백필 불필요.
  // query-guard: bounded -- fetchLimit(=limit*3) 단일 오버페치 페이지, 페이지네이션 커서 없음 (형제 팀/플레이어 쿼리와 동일 계약)
  const lgTitlePromise = includesLgTeamFeed(plan, team)
    ? supabaseAdmin
        .from("videos")
        .select(selectCols)
        .eq("is_short_candidate", true)
        .neq("team_id", "LG")
        .or("title.ilike.%lg%,title.ilike.%엘지%")
        .gte("published_at", sinceDate)
        .order("published_at", { ascending: false })
        .limit(fetchLimit)
    : null;

  if (plan.kind === "empty") {
    // scope 조건 미충족(최애선수/마이팀 미지정) → 빈 피드.
    // 다른 scope로 임의 폴백하지 않는다 (UI는 칩 비활성/섹션 미렌더로 선차단)
    return NextResponse.json(
      { items: [] },
      {
        headers: {
          "Cache-Control": "public, s-maxage=900, stale-while-revalidate=60",
        },
      },
    );
  }

  if (plan.kind === "mixed") {
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
      for (const v of [
        ...(teamResult.data ?? []),
        ...(playerResult.data ?? []),
      ]) {
        if (!seen.has(v.video_id)) {
          seen.add(v.video_id);
          merged.push(v);
        }
      }
      data = merged;
    }
  } else if (plan.kind === "player_only") {
    // scope=favorite_players: 최애선수 태깅 영상만 (팀 무관)
    // query-guard: bounded -- fetchLimit(=limit*3) 단일 오버페치 페이지 + 7일 시간창, 페이지네이션 커서 없음 (기존 혼합 피드의 선수 쿼리와 동일 계약)
    const result = await supabaseAdmin
      .from("videos")
      .select(selectCols)
      .eq("is_short_candidate", true)
      .overlaps("player_ids", playerIds)
      .gte("published_at", sinceDate)
      .order("published_at", { ascending: false })
      .limit(fetchLimit);
    data = result.data;
    error = result.error;
  } else {
    // plan.kind === "team_only" | "all" — fetchLimit 단일 페이지 + 7일 시간창 (기존 else 분기와 동일 쿼리, query-guard baseline 유지)
    const query = supabaseAdmin
      .from("videos")
      .select(selectCols)
      .eq("is_short_candidate", true)
      .gte("published_at", sinceDate)
      .order("published_at", { ascending: false })
      .limit(fetchLimit);

    if (plan.kind === "team_only") {
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
  // (LG 피드 요청이거나 LG 행이 있을 때만 조회 — 다른 팀 피드에 불필요한 쿼리 방지)
  let trustedForLg: ReadonlySet<string> = new Set();
  let playerTagChannelById: ReadonlyMap<string, PlayerTagChannel> = new Map();
  const needsPlayerTagRecheck = (data ?? []).some(
    (v) =>
      String(v.source_type ?? "").startsWith("community_") &&
      Boolean(
        v.player_id || (Array.isArray(v.player_ids) && v.player_ids.length > 0),
      ),
  );
  if (
    team === "LG" ||
    (data ?? []).some((v) => v.team_id === "LG") ||
    needsPlayerTagRecheck
  ) {
    // query-guard: channel_pool 단일 bounded 조회. inactive legacy 채널까지 읽어
    // 저장 당시 tier 계약을 재적용하고, 조회 실패·missing channel은 fail-close한다.
    const poolChannels = await loadChannels(supabaseAdmin);
    playerTagChannelById = new Map(poolChannels.map((c) => [c.channel_id, c]));
    trustedForLg = new Set(
      poolChannels
        .filter(
          (c) =>
            c.is_active && (c.tier === 1 || c.team_affinity?.includes("LG")),
        )
        .map((c) => c.channel_id),
    );
  }

  // 다중 팀 노출 합류: 제목에 독립 LG 언급+야구 문맥이 있는 비-LG 행만 추가.
  // team_id 계약(수집)은 그대로 두고, 합류 행의 노출 라벨만 요청 팀(LG)으로
  // override해서 카드가 `키움` 배지로 보이는 오표시를 막는다 (삼순 라운드4 #2).
  let lgDisplayTeam: Map<string, string> = new Map();
  if (lgTitlePromise) {
    const { data: lgRows, error: lgError } = await lgTitlePromise;
    if (lgError) {
      return NextResponse.json({ error: lgError.message }, { status: 500 });
    }
    const joined = joinLgFeedRows(data ?? [], lgRows ?? [], trustedForLg);
    data = joined.rows;
    lgDisplayTeam = joined.displayTeam;
  }

  // Alias lookup errors fail-close in loadPlayerAliases. The same canonical roster is
  // used for legacy tag revalidation and response labels so the two paths cannot drift.
  const taggedPlayerIds = new Set<string>();
  for (const v of data ?? []) {
    if (v.player_id) taggedPlayerIds.add(v.player_id);
    for (const playerId of v.player_ids ?? []) taggedPlayerIds.add(playerId);
  }
  let playerAliases: PlayerAlias[] = [];
  const playerNameMap = new Map<string, string>();
  if (taggedPlayerIds.size > 0) {
    playerAliases = await loadAliases(supabaseAdmin);
    for (const a of playerAliases) {
      if (taggedPlayerIds.has(a.kbo_id)) playerNameMap.set(a.kbo_id, a.name);
    }
  }

  const requiredFavoriteIds =
    plan.kind === "player_only" ? new Set(playerIds) : null;
  data = (data ?? []).map((v) => {
    const storedIds: string[] = Array.from(
      new Set([
        ...(Array.isArray(v.player_ids) ? v.player_ids : []),
        ...(v.player_id ? [v.player_id] : []),
      ]),
    );
    if (
      !String(v.source_type ?? "").startsWith("community_") ||
      storedIds.length === 0
    ) {
      return { ...v, _playerTagAllowed: true };
    }
    const channel = v.channel_id
      ? (playerTagChannelById.get(v.channel_id) ?? null)
      : null;
    const checked = revalidateStoredPlayerTags(
      {
        title: v.title ?? "",
        channel_id: v.channel_id ?? null,
        source_type: v.source_type ?? null,
        player_id: v.player_id ?? null,
        player_ids: storedIds,
        team_id: v.team_id ?? null,
      },
      playerAliases,
      channel,
      requiredFavoriteIds,
    );
    return {
      ...v,
      _playerTagAllowed: checked.allowed,
      player_id: checked.playerId,
      player_ids: checked.playerIds,
      team_id: checked.teamId,
    };
  });

  // Filter out noisy content — DB flags + runtime title recheck
  // Runtime recheck catches videos ingested before new noise patterns were added
  const excludeSet = DEFAULT_EXCLUDE_FLAGS as ReadonlySet<string>;
  const filtered = (data ?? []).filter((v) => {
    if (v._playerTagAllowed === false) return false;
    if (plan.kind === "team_only" && v.team_id !== team) return false;
    if (
      plan.kind === "mixed" &&
      v.team_id !== team &&
      !(v.player_ids ?? []).some((id: string) => playerIds.includes(id))
    )
      return false;
    const flags: string[] = Array.isArray(v.noise_flags) ? v.noise_flags : [];
    if (flags.some((f) => excludeSet.has(f))) return false;
    // 기존 오분류 행도 즉시 차단: LG 약칭만 걸린 커뮤니티 영상은 야구 문맥 필수
    if (
      !isTeamShortRelevant(v.title ?? "", v.team_id ?? null, {
        hasPlayerTag: Boolean(v.player_id || v.player_ids?.length),
        isOfficial: String(v.source_type ?? "").startsWith("official_"),
        trustedChannel: Boolean(v.channel_id && trustedForLg.has(v.channel_id)),
      })
    )
      return false;
    // Runtime title recheck for patterns added after ingestion
    const runtimeFlags = extractNoiseFlags(v.title, v.channel);
    return !runtimeFlags.some((f) => excludeSet.has(f as string));
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
    teamId: lgDisplayTeam.get(v.video_id) ?? v.team_id ?? null,
    playerName: v.player_id ? (playerNameMap.get(v.player_id) ?? null) : null,
  }));

  // Sort: player-matched items interleaved by player (round-robin), then team videos
  const playerIdSet = new Set(playerIds);
  if (playerIdSet.size > 0) {
    // Group by matched player (first match wins)
    const byPlayer = new Map<string, typeof items>();
    const rest: typeof items = [];
    for (const item of items) {
      const matchedId = item.playerIds.find((id: string) =>
        playerIdSet.has(id),
      );
      if (matchedId) {
        const bucket = byPlayer.get(matchedId);
        if (bucket) bucket.push(item);
        else byPlayer.set(matchedId, [item]);
      } else {
        rest.push(item);
      }
    }

    // Sort each player bucket by recency
    const byRecency = (a: (typeof items)[0], b: (typeof items)[0]) =>
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
          const othersAvailable = buckets.some(
            (_, i) => i !== b && indices[i] < buckets[i].length,
          );
          if (othersAvailable) continue;
        }
        const t = new Date(buckets[b][indices[b]].publishedAt).getTime();
        if (t > bestTime) {
          bestTime = t;
          bestBucket = b;
        }
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

export async function GET(req: NextRequest) {
  return handleShortsFeedGET(req);
}
