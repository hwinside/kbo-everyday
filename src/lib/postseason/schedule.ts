import type { KboGame } from "@/lib/crawler/kbo-api";
import { REGULAR_SEASON_WINDOWS } from "@/lib/constants/season";
import { buildPostseasonLadder, POSTSEASON_STAGES, type LadderSnapshot } from "./ladder";

let cached: LadderSnapshot | null = null;
let pending: Promise<LadderSnapshot | null> | null = null;
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
    // Naver can lag behind the KBO registration of the next round. Probe the
    // upcoming fortnight even when Naver has no dates, plus all known PS dates.
    const dates = new Set(naver.filter(isPS).map(g => g.date));
    const start = new Date(`${window.end.slice(0,4)}-${window.end.slice(4,6)}-${window.end.slice(6,8)}T00:00:00Z`);
    const horizon = new Date(`${today.slice(0,4)}-${today.slice(4,6)}-${today.slice(6,8)}T00:00:00Z`).getTime()+14*86400000;
    for (let i=1; start.getTime()+i*86400000 <= horizon; i++) {
      const date = new Date(start.getTime()+i*86400000).toISOString().slice(0,10).replaceAll("-", "");
      if (date <= `${season}1130`) dates.add(date);
    }
    const queue = [...dates].sort();
    const kbo: KboGame[] = [];
    let successfulDates = 0;
    let cursor = 0;
    const signal = AbortSignal.timeout(6000);
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
      while (cursor < queue.length && !signal.aborted) {
        const date = queue[cursor++];
        try { kbo.push(...await fetchKboGamesOnly(date, "3,4,5,7", { signal })); successfulDates++; }
        catch { /* Keep Naver evidence on source failure; never fabricate a fixture. */ }
      }
    }));
    if (!successfulDates && !naver.length) throw new Error("Postseason sources unavailable");
    cached = buildPostseasonLadder(season, mergePostseasonSchedule(naver, kbo), seeds, Date.now());
    return cached;
  })();
  try { return await pending; } finally { pending = null; }
}

export async function refreshPostseasonSchedule(games: KboGame[], from: string, to = from): Promise<KboGame[]> {
  const window = REGULAR_SEASON_WINDOWS[from.slice(0,4)];
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).replaceAll("-", "");
  if (!window?.finalized || to <= window.end || from.slice(0,4) !== today.slice(0,4) || from > `${today.slice(0,4)}1130`) return games;
  const snapshot = await loadPostseasonSchedule();
  return snapshot ? reconcilePostseasonSchedule(games, snapshot, from, to) : games;
}
