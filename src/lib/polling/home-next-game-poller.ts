import { startVisibilityPoller, type VisibilityPollerDeps } from "./visibility-poller";

interface HomeNextGameDeps<T> extends Omit<VisibilityPollerDeps, "callback" | "intervalMs" | "runImmediately"> {
  dateAtOffset: (offset: number) => string;
  fetchGames: (date: string, signal: AbortSignal) => Promise<T[]>;
  findGame: (games: T[]) => T | undefined;
  onResult: (game: T | null, date?: string) => void;
}

/** Future schedule only: preserve the visible 5-minute cadence and 14-day horizon. */
export function startHomeNextGamePoller<T>(deps: HomeNextGameDeps<T>): () => void {
  let stopped = false;
  let controller: AbortController | null = null;

  const stopPolling = startVisibilityPoller({
    ...deps,
    intervalMs: 5 * 60_000,
    onVisibilityChange: (handler) => deps.onVisibilityChange(() => {
      // Cancel the current date as well as preventing the rest of the date scan.
      if (deps.isHidden()) controller?.abort();
      handler();
    }),
    callback: async () => {
      const request = new AbortController();
      controller = request;
      const active = () => !stopped && !request.signal.aborted && !deps.isHidden();
      try {
        for (let offset = 1; offset <= 14; offset += 1) {
          if (!active()) return;
          const date = deps.dateAtOffset(offset);
          try {
            const games = await deps.fetchGames(date, request.signal);
            // An aborted request may still resolve: never publish or scan another date.
            if (!active()) return;
            const game = deps.findGame(games);
            if (game) {
              deps.onResult(game, date);
              return;
            }
          } catch {
            if (!active()) return;
            // Preserve the existing best-effort scan after an individual date fails.
          }
        }
        if (active()) deps.onResult(null);
      } finally {
        if (controller === request) controller = null;
      }
    },
  });

  return () => {
    stopped = true;
    stopPolling();
    controller?.abort();
  };
}
