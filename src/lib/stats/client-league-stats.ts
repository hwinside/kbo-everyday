/** Share only active public season-stat requests; never reuse a settled result. */
export type LeagueStatsPayload = { stats?: Record<string, unknown>[] } | Record<string, unknown>[];
const inFlight = new Map<string, Promise<LeagueStatsPayload>>();

export function fetchLeagueStats(type: "batter" | "pitcher", season: number): Promise<LeagueStatsPayload> {
  const url = `/api/stats?type=${type}&season=${season}`;
  const active = inFlight.get(url);
  if (active) return active;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const request = Promise.resolve()
    .then(() => fetch(url, { signal: controller.signal }))
    .then(response => response.ok ? response.json() as Promise<LeagueStatsPayload> : [])
    .finally(() => {
      clearTimeout(timeout);
      if (inFlight.get(url) === request) inFlight.delete(url);
    });
  inFlight.set(url, request);
  return request;
}
