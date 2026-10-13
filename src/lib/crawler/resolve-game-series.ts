import { normalizeSeriesId, type GameSeriesId } from "./game-series";

// Identity is immutable for a game ID. Bound memory; never cache missing/failed lookups.
const identities = new Map<string, GameSeriesId>();
export function rememberGameSeries(gameId: string, value: unknown): GameSeriesId | undefined {
  const srId = normalizeSeriesId(value);
  if (srId !== undefined) {
    if (identities.size >= 2048) identities.delete(identities.keys().next().value!);
    identities.set(gameId, srId);
  }
  return srId;
}
export function knownGameSeries(gameId: string): GameSeriesId | undefined {
  return identities.get(gameId);
}
export async function resolveGameSeries(
  gameId: string,
  opts?: { srId?: unknown; signal?: AbortSignal },
): Promise<GameSeriesId> {
  opts?.signal?.throwIfAborted();
  const known = normalizeSeriesId(opts?.srId) ?? knownGameSeries(gameId);
  if (known !== undefined) return rememberGameSeries(gameId, known)!;
  const signal = opts?.signal ?? AbortSignal.timeout(2500);
  // Independent schedule lookup: no detailed APIs or ID-conversion recursion.
  const { fetchKboGamesOnly } = await import("./kbo-api");
  const { fetchNaverGames } = await import("./naver-games");
  const find = (games: { gameId: string; srId?: string }[]) => {
    const srId = normalizeSeriesId(games.find(g => g.gameId === gameId)?.srId);
    if (srId === undefined) throw new Error(`Series identity unavailable: ${gameId}`);
    return srId;
  };
  // Race authoritative sources; an unavailable KBO must not consume Naver's budget.
  const lookup = Promise.any([
    fetchKboGamesOnly(gameId.slice(0, 8), undefined, { signal }).then(find),
    fetchNaverGames(gameId.slice(0, 8), undefined, { signal }).then(find),
  ]);
  const srId = await new Promise<GameSeriesId>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    lookup.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
  rememberGameSeries(gameId, srId);
  return srId;
}
