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

// ── 시즌 우주 fail-closed 수집 (삼순 리뷰 P0) ────────────────────────────────

/** 시즌 경기 수집 결과 + 완료 증거. */
export interface SeasonGameCollection {
  games: KboGame[];
  /** 시즌 범위의 모든 날짜를 예외 없이 수집했는가 (실패 날짜 0). */
  complete: boolean;
  /** 시즌 범위(3월~현재월/11월) 전체 날짜(YYYYMMDD). */
  expectedDates: string[];
  /** fetch 성공한 날짜. */
  collectedDates: string[];
  /** fetch 실패해 우주에서 빠진 날짜. */
  failedDates: string[];
}

export type SeasonGameFetcher = (date: string, srId: string) => Promise<KboGame[]>;

/** 시즌 범위(3월 1일~현재월 말 또는 11월 말)의 모든 YYYYMMDD 날짜. */
function getSeasonDates(season: number): string[] {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
  const [todayYear, todayMonth] = today.split("-").map(Number);
  const startMonth = 3; // KBO 정규시즌 3월 개막
  const endMonth = todayYear === season ? todayMonth : 11;
  const dates: string[] = [];
  for (let m = startMonth; m <= endMonth; m++) {
    const daysInMonth = new Date(season, m, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      dates.push(`${season}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`);
    }
  }
  return dates;
}

/**
 * 시즌 경기 우주를 일자별로 수집하되 완료 증거(complete/failedDates)를 함께 반환한다
 * (삼순 리뷰 P0 fail-closed). getMonthGames의 fail-soft partial 캐시와 달리,
 *  - 한 날짜라도 fetch 실패하면 complete=false로 표시하고
 *  - partial(비어 있지 않은 부분 우주)을 authoritative 캐시로 재사용하지 않는다.
 * 호출측(venue-stats route)은 complete=false면 시즌 비교를 fail-closed 강등한다
 * — 조용한 non-empty partial 우주가 stats를 false-green으로 만드는 것을 차단한다.
 * fetcher는 테스트 결함 주입용 seam(기본값 fetchGames = 실네트워크 경계)이며,
 * 수집 로직(allSettled·완료 판정) 자체는 항상 실제 helper를 경유한다.
 */
export async function collectSeasonGameUniverse(
  season: number,
  srId = "0,1,3,4,5,7,9",
  opts?: { fetcher?: SeasonGameFetcher },
): Promise<SeasonGameCollection> {
  const fetcher = opts?.fetcher ?? fetchGames;
  const dates = getSeasonDates(season);
  const results = await Promise.allSettled(dates.map((d) => fetcher(d, srId)));

  const games: KboGame[] = [];
  const collectedDates: string[] = [];
  const failedDates: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      collectedDates.push(dates[i]);
      games.push(...r.value);
    } else {
      failedDates.push(dates[i]);
    }
  });

  return {
    games,
    complete: failedDates.length === 0,
    expectedDates: dates,
    collectedDates,
    failedDates,
  };
}
