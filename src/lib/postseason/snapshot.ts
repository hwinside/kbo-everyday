import { fetchNaverGames } from "@/lib/crawler/naver-games";
import { isPostseason } from "@/lib/crawler/game-series";
import type { KboGame } from "@/lib/crawler/kbo-api";
import { REGULAR_SEASON_WINDOWS } from "@/lib/constants/season";

export interface PostseasonSnapshot { season: number; fetchedAt: number; games: KboGame[] }
const cache = new Map<number, PostseasonSnapshot>();
/** Published games only. No rank-derived hypothetical matchups or fake wins. */
export async function loadPostseasonSnapshot(season: number): Promise<PostseasonSnapshot | null> {
  const window = REGULAR_SEASON_WINDOWS[String(season)];
  if (!window?.finalized) return null;
  const known = cache.get(season);
  if (known && Date.now() - known.fetchedAt < 60_000) return known;
  const games = await fetchNaverGames(window.end, undefined, {
    toDate: `${season}1130`, signal: AbortSignal.timeout(2500),
  });
  const snapshot = { season, fetchedAt: Date.now(), games: games.filter(g => isPostseason(g.srId)) };
  cache.set(season, snapshot);
  return snapshot;
}
