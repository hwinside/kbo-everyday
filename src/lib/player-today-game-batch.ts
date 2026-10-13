import type { PlayerTodayGameResponse } from "@/lib/services/player-today-game";

// The favorites store permits at most five players. This public read endpoint never
// reads a user's saved favorites, and passes the same team/name/position as the old
// individual requests (including the caller's pitcher classification).
export const MAX_TODAY_GAME_BATCH = 5;
export interface TodayGameBatchPlayer {
  playerId: string;
  teamId: number;
  name: string;
  pos: "투수" | "타자";
}

export interface TodayGameBatchResponse {
  items: Record<string, PlayerTodayGameResponse | null>;
}

export function parseTodayGameBatch(raw: string | null): TodayGameBatchPlayer[] | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TODAY_GAME_BATCH) return null;
    const seen = new Set<string>();
    const players: TodayGameBatchPlayer[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const p = entry as Record<string, unknown>;
      if (
        typeof p.playerId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(p.playerId)
        || seen.has(p.playerId)
        || typeof p.teamId !== "number" || !Number.isInteger(p.teamId) || p.teamId < 1 || p.teamId > 10
        || typeof p.name !== "string" || !p.name.trim() || p.name.length > 64
        || (p.pos !== "투수" && p.pos !== "타자")
      ) return null;
      seen.add(p.playerId);
      players.push({ playerId: p.playerId, teamId: p.teamId, name: p.name, pos: p.pos });
    }
    return players;
  } catch {
    return null;
  }
}

type PlayerResult = {
  body: PlayerTodayGameResponse;
  status?: number;
  headers?: HeadersInit;
};

// Only these existing single-route policies can be inherited. Unknown policies,
// failures and no-store fail closed; no fresh cache is layered on the service.
function cacheSeconds(headers: HeadersInit | undefined): number | null {
  const original = new Headers(headers);
  if (["Set-Cookie", "Vary", "CDN-Cache-Control", "Vercel-CDN-Cache-Control", "Cloudflare-CDN-Cache-Control"]
    .some((name) => original.has(name))) return null;
  const value = original.get("Cache-Control") ?? "";
  const match = /^s-maxage=(20|60)(?:, stale-while-revalidate=40)?$/.exec(value);
  return match ? Number(match[1]) : null;
}

export async function collectTodayGameBatch(
  players: readonly TodayGameBatchPlayer[],
  load: (player: TodayGameBatchPlayer) => Promise<PlayerResult>,
  now: () => number = Date.now,
): Promise<{ body: TodayGameBatchResponse; headers: Record<string, string> }> {
  const results = await Promise.all(players.map(async (player) => {
    try {
      const result = await load(player);
      return { player, result, receivedAt: now() };
    } catch {
      return { player, result: null, receivedAt: now() };
    }
  }));
  const items: TodayGameBatchResponse["items"] = Object.create(null);
  let remainingSeconds = Infinity;
  const completedAt = now();
  for (const { player, result, receivedAt } of results) {
    const successful = result && (result.status === undefined || result.status === 200);
    items[player.playerId] = successful ? result.body : null;
    const ttl = successful ? cacheSeconds(result.headers) : null;
    const elapsedMs = completedAt - receivedAt;
    // A slow sibling must not restart the earlier result's full TTL. Do not extend
    // stale serving either: the aggregate deliberately does not inherit SWR.
    const remaining = ttl !== null && Number.isFinite(elapsedMs) && elapsedMs >= 0
      ? Math.floor(ttl - elapsedMs / 1000)
      : 0;
    remainingSeconds = Math.min(remainingSeconds, remaining);
  }
  return {
    body: { items },
    headers: {
      "Cache-Control": Number.isFinite(remainingSeconds) && remainingSeconds > 0
        ? `public, max-age=0, s-maxage=${remainingSeconds}, must-revalidate`
        : "private, no-store, max-age=0",
    },
  };
}

export async function fetchTodayGameBatch(
  players: readonly TodayGameBatchPlayer[],
  fetcher: typeof fetch = fetch,
): Promise<TodayGameBatchResponse["items"]> {
  if (players.length === 0) return {};
  // Reordering favorites changes presentation, not the cache key. Explicit fields
  // also keep the serialization stable and avoid sending profile-only data.
  const ordered = players.map(({ playerId, teamId, name, pos }) => ({ playerId, teamId, name, pos }))
    .sort((a, b) => a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0);
  const raw = JSON.stringify(ordered);
  if (!parseTodayGameBatch(raw)) return {};
  try {
    const query = new URLSearchParams({ players: raw });
    const response = await fetcher(`/api/player-today-game/batch?${query}`);
    if (!response.ok) return {};
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("items" in body)) return {};
    const items = (body as TodayGameBatchResponse).items;
    if (!items || typeof items !== "object" || Array.isArray(items)) return {};
    // Do not accept another request's IDs, or fan out to the old endpoint on failure.
    return Object.fromEntries(players.map(({ playerId }) => [
      playerId,
      Object.hasOwn(items, playerId) ? items[playerId] : null,
    ]));
  } catch {
    return {};
  }
}
