import { isAllStarGameId } from "@/lib/constants/teams";
import { normalizeSeriesId, isPostseason } from "./game-series";
import { knownGameSeries, resolveGameSeries } from "./resolve-game-series";

/** Pure converter; callers with only a game ID must use resolveNaverGameId. */
export function naverGameId(kboGameId: string, srId?: string | number): string {
  const year = kboGameId.slice(0, 4);
  const series = normalizeSeriesId(srId) ?? knownGameSeries(kboGameId);
  const prefix = isAllStarGameId(kboGameId) || series === "9" ? "9999"
    : isPostseason(series) ? series!.repeat(4) : year;
  return `${prefix}${kboGameId.slice(4)}${year}`;
}
export async function resolveNaverGameId(kboGameId: string, opts?: { srId?: unknown; signal?: AbortSignal }): Promise<string> {
  if (isAllStarGameId(kboGameId)) return naverGameId(kboGameId, "9");
  return naverGameId(kboGameId, await resolveGameSeries(kboGameId, opts));
}
