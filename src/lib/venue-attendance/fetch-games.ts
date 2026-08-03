import type { KboGame } from "@/lib/crawler/kbo-api";
import type { VenueAttendanceRow } from "./summary";

interface FetchAttendanceGamesOptions {
  deadlineMs?: number;
  maxConcurrency?: number;
  fetcher: (date: string) => Promise<KboGame[]>;
}

async function fetchWithinDeadline(
  date: string,
  deadlineAt: number,
  fetcher: (date: string) => Promise<KboGame[]>,
): Promise<KboGame[] | null> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return null;

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const resolveAtDeadline = () => {
      const nextRemainingMs = deadlineAt - Date.now();
      if (nextRemainingMs > 0) {
        timer = setTimeout(resolveAtDeadline, nextRemainingMs);
        return;
      }
      resolve(null);
    };
    timer = setTimeout(resolveAtDeadline, remainingMs);
    void fetcher(date).then(
      (games) => {
        clearTimeout(timer);
        resolve(games);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** KBO 장애도 API 전체를 붙잡지 않도록 동시성 5·전체 8초 안에서만 조회한다. */
export async function fetchAttendanceGamesWithinDeadline(
  rows: VenueAttendanceRow[],
  options: FetchAttendanceGamesOptions,
): Promise<Map<string, KboGame>> {
  const dates = [...new Set(rows.map((row) => row.game_date.replaceAll("-", "")))];
  const gamesById = new Map<string, KboGame>();
  const deadlineAt = Date.now() + (options.deadlineMs ?? 8_000);
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? 5);
  const fetcher = options.fetcher;
  let cursor = 0;

  async function worker() {
    while (cursor < dates.length && Date.now() < deadlineAt) {
      const date = dates[cursor++];
      const games = await fetchWithinDeadline(date, deadlineAt, fetcher);
      if (games) {
        for (const game of games) gamesById.set(game.gameId, game);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, dates.length) }, () => worker()),
  );
  return gamesById;
}
