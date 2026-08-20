import { resolvePlayer } from "@/lib/utils/resolve-player";
import { parsePlayerStats, type PlayerDetailStats } from "@/lib/kbo/player-stats-parser";

const KBO_BASE = "https://www.koreabaseball.com";

async function fetchPlayerStats(playerId: string, position: string) {
  const isPitcher = position === "투수";
  const url = isPitcher
    ? `${KBO_BASE}/Record/Player/PitcherDetail/Basic.aspx?playerId=${playerId}`
    : `${KBO_BASE}/Record/Player/HitterDetail/Basic.aspx?playerId=${playerId}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: KBO_BASE },
    next: { revalidate: 3600 },
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const html = await res.text();
  return parsePlayerStats(html, isPitcher);
}

const cache: Record<string, { data: PlayerDetailStats; ts: number }> = {};

export type { PlayerDetailStats };

export async function getPlayerStatsRouteResult(rawId: string | null, pos = "타자"): Promise<{
  // missing-id 분기는 base route 계약 그대로 `{ error }` 만 반환한다(stats 필드 추가 금지 — 삼순 #1257 4차 ②).
  body: { stats?: PlayerDetailStats | null; cached?: boolean; error?: string };
  status?: number;
  headers?: HeadersInit;
}> {
  if (!rawId) return { body: { error: "id required" }, status: 400 };

  const id = resolvePlayer(rawId)?.numericId || rawId;
  const cacheKey = `player-${id}-${pos}`;
  const okHeaders = { "Cache-Control": "public, s-maxage=60" } as const;
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.ts < 3_600_000) {
    return { body: { stats: cached.data, cached: true }, headers: okHeaders };
  }

  try {
    const stats = await fetchPlayerStats(id, pos);
    if (stats) cache[cacheKey] = { data: stats, ts: Date.now() };
    return { body: { stats, cached: false }, headers: okHeaders };
  } catch (e: unknown) {
    return {
      body: { error: (e as Error).message, stats: null },
      status: 500,
      headers: { "Cache-Control": "no-store" },
    };
  }
}
