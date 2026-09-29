/** Public player reads: share overlapping fetches, give each caller its own response body. */
const inFlight = new Map<string, Promise<Response>>();
export function fetchPlayerResource(
  resource: "player-stats" | "player-game-logs",
  playerId: string,
  position: string,
): Promise<Response> {
  const url = `/api/${resource}?id=${encodeURIComponent(playerId)}&pos=${encodeURIComponent(position)}`;
  let request = inFlight.get(url);
  if (!request) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const pending = Promise.resolve()
      .then(() => fetch(url, { signal: controller.signal }))
      .finally(() => {
        clearTimeout(timeout);
        if (inFlight.get(url) === pending) inFlight.delete(url);
      });
    inFlight.set(url, pending);
    request = pending;
  }
  return request.then(response => response.clone());
}
