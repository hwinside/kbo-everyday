import { runBeforeDeadline } from "@/lib/async-deadline";
import type { KboGame } from "@/lib/crawler/kbo-api";
import { REGULAR_SEASON_WINDOWS } from "@/lib/constants/season";
import { buildPostseasonLadder, POSTSEASON_STAGES, type LadderSnapshot } from "./ladder";

let cached: LadderSnapshot | null = null;
let pending: Promise<LadderSnapshot | null> | null = null;
const kboDates = new Map<string, { fetchedAt: number; games: KboGame[] }>();
export const KBO_SUPPLEMENT_TTL_MS = 5 * 60_000;
const isPS = (g: KboGame) => POSTSEASON_STAGES.some(id => id === g.srId);

/** Actual upstream rows only: never invent dates, game IDs or opponents. */
export function mergePostseasonSchedule(naver: KboGame[], kbo: KboGame[]): KboGame[] {
  const rows = new Map(naver.filter(isPS).map(g => [g.gameId, g]));
  for (const g of kbo.filter(isPS)) rows.set(g.gameId, g);
  return [...rows.values()];
}

/** Remove only scheduled games proven unnecessary; keep final/live/cancelled history. */
export function reconcilePostseasonSchedule(games: KboGame[], snapshot: LadderSnapshot, from: string, to = from): KboGame[] {
  const rows = new Map(games.map(g => [g.gameId, g]));
  for (const round of snapshot.rounds) {
    for (const game of round.games) {
      if (game.date < from || game.date > to) continue;
      if (game.notNeeded) rows.delete(game.gameId);
      else if (!rows.has(game.gameId) || rows.get(game.gameId)?.status === "scheduled") rows.set(game.gameId, game);
    }
  }
  return [...rows.values()].sort((a,b) => a.gameId.localeCompare(b.gameId));
}

export function postseasonSupplementDates(today: string): string[] {
  const start = Date.parse(`${today.slice(0,4)}-${today.slice(4,6)}-${today.slice(6,8)}T00:00:00Z`);
  return Array.from({ length: 15 }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0,10).replaceAll("-", ""))
    .filter(date => date <= `${today.slice(0,4)}1130`);
}

/** General collectors preserve their source rows when eligibility is unavailable. */
export async function filterPostseasonGamesBestEffort(
  games: KboGame[], date: string, deadlineAtMs: number, load = loadPostseasonSchedule,
): Promise<KboGame[]> {
  if (!games.length || !isCurrentPostseasonDate(date)) return games;
  const previous = cached?.season === Number(date.slice(0,4)) ? cached : null;
  try {
    const refreshing = load().catch(() => null);
    const snapshot = previous ?? await runBeforeDeadline(() => refreshing, deadlineAtMs);
    return snapshot ? excludeNotNeeded(games, snapshot, g => g.gameId) : games;
  } catch { return previous ? excludeNotNeeded(games, previous, g => g.gameId) : games; }
}

export async function loadPostseasonSchedule(): Promise<LadderSnapshot | null> {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).replaceAll("-", "");
  const season = Number(today.slice(0,4));
  const window = REGULAR_SEASON_WINDOWS[String(season)];
  if (!window?.finalized || today <= window.end || today > `${season}1130`) return null;
  if (cached?.season === season && Date.now() - cached.fetchedAt < 30_000) return cached;
  if (pending) return pending;
  pending = (async () => {
    const [{ fetchKboGamesOnly }, { fetchNaverGames }, { loadPostseasonSeeds }] = await Promise.all([import("@/lib/crawler/kbo-api"), import("@/lib/crawler/naver-games"), import("./seeds")]);
    const [naver, seeds] = await Promise.all([
      fetchNaverGames(window.end, undefined, { toDate: `${season}1130`, timeoutMs: 3000 }).catch(() => [] as KboGame[]),
      loadPostseasonSeeds(season),
    ]);
    // Past results come from Naver; KBO supplements only the next fortnight.
    // Cache each successful date (including empty dates) independently of the
    // 30-second ladder refresh, so live result refreshes do not fan out again.
    const queue = postseasonSupplementDates(today);
    for (const date of kboDates.keys()) if (date < today) kboDates.delete(date);
    const kbo: KboGame[] = [];
    let successfulDates = 0;
    let cursor = 0;
    const signal = AbortSignal.timeout(6000);
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
      while (cursor < queue.length && !signal.aborted) {
        const date = queue[cursor++];
        const previous = kboDates.get(date);
        if (previous && Date.now() - previous.fetchedAt < KBO_SUPPLEMENT_TTL_MS) {
          kbo.push(...previous.games); successfulDates++; continue;
        }
        try {
          const games = await fetchKboGamesOnly(date, "3,4,5,7", { signal });
          kboDates.set(date, { games, fetchedAt: Date.now() });
          kbo.push(...games); successfulDates++;
        }
        catch { /* Keep Naver evidence on source failure; never fabricate a fixture. */ }
      }
    }));
    if (!successfulDates && !naver.length) throw new Error("Postseason sources unavailable");
    cached = buildPostseasonLadder(season, mergePostseasonSchedule(naver, kbo), seeds, Date.now());
    return cached;
  })();
  try { return await pending; } finally { pending = null; }
}

export function isCurrentPostseasonDate(date: string): boolean {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).replaceAll("-", "");
  const window = REGULAR_SEASON_WINDOWS[date.slice(0, 4)];
  return !!window?.finalized && date > window.end && date.slice(0, 4) === today.slice(0, 4) && date <= `${today.slice(0, 4)}1130`;
}

export async function refreshPostseasonSchedule(
  games: KboGame[], from: string, to = from, deadlineAtMs = Date.now() + 1500,
  load = loadPostseasonSchedule,
): Promise<KboGame[]> {
  if (!isCurrentPostseasonDate(to)) return games;
  const previous = cached?.season === Number(from.slice(0, 4)) ? cached : null;
  try {
    const refreshing = load().catch(() => null);
    const snapshot = previous ?? await runBeforeDeadline(() => refreshing, deadlineAtMs);
    // A prior successful snapshot is usable immediately. Refresh failure must
    // never turn a healthy home/games response into an error.

    return snapshot ? reconcilePostseasonSchedule(games, snapshot, from, to) : games;
  } catch { return previous ? reconcilePostseasonSchedule(games, previous, from, to) : games; }
}

/** Filter only: notification collectors must retain their own source/status contract. */
export function excludeNotNeeded<T>(games: T[], snapshot: LadderSnapshot, id: (game: T) => string): T[] {
  const excluded = new Set(snapshot.rounds.flatMap(r => r.games.filter(g => g.notNeeded).map(g => g.gameId)));
  return games.filter(g => !excluded.has(id(g)));
}

/** Operational callers fail closed on unknown schedule, rather than send an obsolete event. */
export async function filterNeededPostseasonGames<T>(
  games: T[], date: string, id: (game: T) => string, deadlineAtMs = Date.now() + 1500,
  load = loadPostseasonSchedule,
): Promise<T[]> {
  if (!games.length || !isCurrentPostseasonDate(date)) return games;
  const snapshot = await runBeforeDeadline(load, deadlineAtMs);
  if (!snapshot) throw new Error("Postseason eligibility unavailable");
  return excludeNotNeeded(games, snapshot, id);
}
