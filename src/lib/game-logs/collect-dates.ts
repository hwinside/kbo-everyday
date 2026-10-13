import type { KboGame } from "@/lib/crawler/kbo-api";

/** A failed date must not suppress another date's recheck, nor become empty success. */
export async function collectFinalGamesByDate(
  dates: string[], fetcher: (date: string) => Promise<KboGame[]>,
) {
  const settled = await Promise.allSettled(dates.map(async (date) => fetcher(date)));
  const finalsById = new Map<string, KboGame>();
  const failedDates: { date: string; error: string }[] = [];
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      failedDates.push({ date: dates[index], error: result.reason instanceof Error
        ? result.reason.message : String(result.reason) });
      return;
    }
    for (const game of result.value) {
      if (game.status === "final") finalsById.set(game.gameId, game);
    }
  });
  return { finals: [...finalsById.values()], failedDates };
}
