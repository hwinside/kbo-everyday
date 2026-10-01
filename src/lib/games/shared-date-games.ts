import type { KboGame } from "@/lib/crawler/kbo-api";

// Reuse the existing date-only CDN cache across teams, modes and scan ranges.
// In-process single-flight also coalesces simultaneous cold scans; it is not a TTL cache.
const flights = new Map<string, Promise<KboGame[]>>();

export function fetchSharedDateGames(origin: string, date: string): Promise<KboGame[]> {
  const url = new URL("/api/games", origin);
  url.searchParams.set("date", date);
  const key = url.toString();
  const current = flights.get(key);
  if (current) return current;
  const flight = (async () => {
    // no-store disables the Next fetch cache, not the destination's CDN cache.
    // Do not forward cookies, team parameters or a caller's cancellation signal.
    const response = await fetch(key, {
      cache: "no-store",
      headers: { "User-Agent": "kbo-everyday-next-game/1.0" },
      signal: AbortSignal.timeout(3_500),
    });
    if (!response.ok) throw new Error(`Date games HTTP ${response.status}`);
    const body = await response.json();
    if (body?.date !== date || !Array.isArray(body.games)) {
      throw new Error("Invalid date games response");
    }
    return body.games as KboGame[];
  })();
  flights.set(key, flight);
  const clear = () => { if (flights.get(key) === flight) flights.delete(key); };
  void flight.then(clear, clear);
  return flight;
}
