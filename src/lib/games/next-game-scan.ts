/** Bounded calendar scan shared by the API and deterministic failure tests. */
export function scanDates(from: string, to: string): string[] | null {
  const parse = (value: string) => {
    if (!/^\d{8}$/.test(value)) return NaN;
    const ms = Date.parse(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10).replaceAll("-", "") === value ? ms : NaN;
  };
  const start = parse(from), end = parse(to);
  const days = (end - start) / 86_400_000;
  if (!Number.isInteger(days) || days < 0 || days > 14) return null;
  return Array.from({ length: days + 1 }, (_, offset) =>
    new Date(start + offset * 86_400_000).toISOString().slice(0, 10).replaceAll("-", ""));
}

export async function scanNextGame<T>(deps: {
  dates: string[];
  signal: AbortSignal;
  fetchGames: (date: string) => Promise<T[]>;
  matches: (game: T) => boolean;
}): Promise<{ game: T | null; date?: string; failedDates: string[] }> {
  const failedDates: string[] = [];
  for (const date of deps.dates) {
    deps.signal.throwIfAborted();
    try {
      const games = await deps.fetchGames(date);
      deps.signal.throwIfAborted();
      const game = games.find(deps.matches);
      if (game) return { game, date, failedDates };
    } catch (error) {
      if (deps.signal.aborted) throw error;
      failedDates.push(date);
    }
  }
  return { game: null, failedDates };
}
