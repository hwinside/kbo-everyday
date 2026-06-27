/**
 * Shared in-memory cache for KBO games by month.
 * Both /api/team-schedule and /api/team-matchups use this to avoid
 * repeated full-month date loops.
 *
 * TTL: 10 minutes during game hours (KST 11:00-24:00), 60 minutes otherwise.
 */

import { fetchGames, type KboGame } from "./kbo-api";

interface CacheEntry {
  data: KboGame[];
  expiresAt: number;
}

const monthCache = new Map<string, CacheEntry>();

function getTtlMs(): number {
  const kstHour = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })
  ).getHours();
  const isGameHours = kstHour >= 11 && kstHour < 24;
  return isGameHours ? 10 * 60 * 1000 : 60 * 60 * 1000;
}

/** Returns all dates (YYYYMMDD) in a given month (YYYY-MM). */
function getDatesInMonth(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const dates: string[] = [];
  const daysInMonth = new Date(y, m, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
    dates.push(dateStr);
  }
  return dates;
}

/**
 * Fetches and caches all completed/live games for a given month (YYYY-MM).
 * Fails soft: if individual dates error, they're skipped; returns partial data.
 */
export async function getMonthGames(month: string, srId = "0,1,3,4,5,7,9"): Promise<KboGame[]> {
  const cacheKey = `${month}::${srId}`;
  const cached = monthCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const dates = getDatesInMonth(month);
  const results = await Promise.allSettled(dates.map((d) => fetchGames(d, srId)));

  const games: KboGame[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      games.push(...r.value);
    }
    // silently skip rejected dates
  }

  monthCache.set(cacheKey, { data: games, expiresAt: Date.now() + getTtlMs() });
  return games;
}

/**
 * Returns completed games for all months from season start (March) through
 * the current month. Used by matchups to aggregate season-to-date H2H records.
 */
export async function getSeasonGames(season: number, srId = "0,1,3,4,5,7,9"): Promise<KboGame[]> {
  const today = new Date().toLocaleDateString("sv-SE", {
    timeZone: "Asia/Seoul",
  });
  const [todayYear, todayMonth] = today.split("-").map(Number);

  const months: string[] = [];
  const startMonth = 3; // KBO season starts in March
  const endMonth = todayYear === season ? todayMonth : 11;

  for (let m = startMonth; m <= endMonth; m++) {
    months.push(`${season}-${String(m).padStart(2, "0")}`);
  }

  const monthResults = await Promise.all(months.map((m) => getMonthGames(m, srId)));
  return monthResults.flat();
}
