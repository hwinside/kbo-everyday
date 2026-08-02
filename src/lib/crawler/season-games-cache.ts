/**
 * Shared in-memory cache for KBO games by month.
 * Both /api/team-schedule and /api/team-matchups use this to avoid
 * repeated full-month date loops.
 *
 * TTL: 10 minutes during game hours (KST 11:00-24:00), 60 minutes otherwise.
 */

import { fetchGames, fetchKboGamesOnly, type KboGame } from "./kbo-api";
import { REGULAR_SEASON_WINDOWS, type RegularSeasonWindow } from "./naver-games";

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

/**
 * 시즌 우주 수집용 일자 fetch 결과 — games + 빈-응답 교차검증 증거.
 * emptyVerified: games가 비었을 때 그 비어있음이 무경기 확정으로 교차검증됐는가.
 *   games.length>0이면 의미 없음(true 취급). games.length===0 && emptyVerified===false 는
 *   "unverified soft-empty"(교차확인 불가) — 상위 collectSeasonGameUniverse가 fail-closed 한다.
 */
export interface SeasonGameFetchResult {
  games: KboGame[];
  emptyVerified: boolean;
}

export type SeasonGameFetcher = (date: string, srId: string) => Promise<SeasonGameFetchResult>;

/** Naver 전-시리즈 교차확인 srId (naver-games DEFAULT_ALL_SR_ID와 동일). */
const NAVER_FULL_SR_ID = "0,1,3,4,5,7,9";
/** 정규시즌 전용 srId (venue-stats REGULAR_SEASON_SR_ID와 동일). */
const REGULAR_ONLY_SR_ID = "0";
/** 비정규 시리즈(시범 1 · 포스트 3,4,5,7 · 올스타 9) srId — 전-시리즈에서 정규(0) 제외. */
const NON_REGULAR_SR_ID = "1,3,4,5,7,9";

/**
 * 시즌 우주 수집용 일자 fetcher(기본값) — 정규시즌(srId) 경기를 실제 fetchGames로 가져오되,
 * 빈 응답(무경기)일 때만 "verified-empty(무경기 확정)"를 교차검증한다(삼순 P0-1).
 *  - games 있으면 그대로 성공(emptyVerified 무의미).
 *  - 빈 응답이면 기존 교차검증 수단(fetchNaverGames 전-시리즈)을 재사용해 그 날짜 무경기를 확인:
 *    Naver도 빈 배열 → 무경기 확정(emptyVerified=true, 성공).
 *  - 정규시즌 전용(srId="0")은 series-aware(삼순 4차 P0-1): Naver는 series 미구분이므로
 *    Naver 경기 전부가 KBO 비정규 시리즈 조회(srId="1,3,4,5,7,9")로 gameId exact 설명되면
 *    정규 무경기 확정(시범/올스타일 GREEN). 설명 안 되는 경기가 남거나 조회 실패 →
 *    교차확인 불가(emptyVerified=false) → 상위에서 fail-closed.
 * 정규시즌 전용 srId="0"의 soft-empty(KBO 200 game:[])가 조용히 성공 날짜가 되어
 * non-empty partial 우주를 authoritative로 만드는 것을 차단한다.
 * (fetchGames가 srId="0" soft-empty에서 내부 Naver 교차확인을 시리즈 계약 때문에 거절하고
 *  빈 배열을 fulfill하는 것을 그대로 신뢰하지 않는다.)
 */
export async function fetchSeasonUniverseDate(
  date: string,
  srId = "0,1,3,4,5,7,9",
): Promise<SeasonGameFetchResult> {
  // 정규 전용 우주는 source를 숨기는 fetchGames fallback 결과를 곧바로 신뢰하지 않는다.
  // KBO regular 원본이 비었을 때 Naver 전시리즈와 KBO non-regular를 exact 대조해야
  // window 내부 올스타(예: 20260711 WEEA0)가 정규 우주로 섞이지 않는다.
  if (srId === REGULAR_ONLY_SR_ID) {
    let regular: KboGame[];
    try {
      regular = await fetchKboGamesOnly(date, REGULAR_ONLY_SR_ID);
    } catch {
      return { games: [], emptyVerified: false };
    }
    if (regular.length > 0) return { games: regular, emptyVerified: false };
    try {
      const { fetchNaverGames } = await import("./naver-games");
      const cross = await fetchNaverGames(date, NAVER_FULL_SR_ID);
      if (cross.length === 0) return { games: [], emptyVerified: true };
      const nonRegular = await fetchKboGamesOnly(date, NON_REGULAR_SR_ID);
      const nonRegularIds = new Set(nonRegular.map((game) => game.gameId));
      return { games: [], emptyVerified: cross.every((game) => nonRegularIds.has(game.gameId)) };
    } catch {
      return { games: [], emptyVerified: false };
    }
  }

  const games = await fetchGames(date, srId);
  if (games.length > 0) return { games, emptyVerified: false };
  // 빈 응답 — 무경기 확정 교차검증. 확정 못하면 unverified(fail-closed 대상).
  try {
    const { fetchNaverGames } = await import("./naver-games");
    const cross = await fetchNaverGames(date, NAVER_FULL_SR_ID);
    if (cross.length === 0) return { games: [], emptyVerified: true };
    // 삼순 4차 P0-1 series-aware — 정규시즌 전용(srId="0") 우주에서는 Naver가
    // series 미구분(시범/올스타 포함)이므로, Naver 경기가 있어도 그 전부가 KBO 자체
    // 비정규 시리즈 조회(srId=NON_REGULAR)로 gameId exact 설명되면 "정규 무경기 확정"이다
    // (시범·올스타는 정규 우주 제외 대상이지 verification 실패가 아님 — 예: 2026-03-12
    // KBO 정규 []·Naver 시범 5경기). 비정규로 설명 안 되는 Naver 경기가 하나라도 남으면
    // 정규경기 soft-drop 가능성 → unverified fail-closed 유지.
    // 전-시리즈 우주 등 그 외 srId — Naver에 경기가 있으면 실제 경기 누락 가능성 → unverified.
    return { games: [], emptyVerified: false };
  } catch {
    return { games: [], emptyVerified: false };
  }
}

/**
 * 시즌 범위(3월 1일~현재월 말 또는 11월 말)의 모든 YYYYMMDD 날짜.
 *
 * 정규시즌 전용(srId="0") 우주는 검증된 개막일 전 날짜만 제외한다.
 * 3월 1일~개막일 전날은 정규경기가 존재할 수 없는 날짜인데, 그 구간은 window 밖이라
 * srId="0" 조회가 "KBO 200-empty 미검증"으로 throw 한다(시범경기 오염 방지 fail-close).
 * 그 날짜를 우주에 넣으면 collectSeasonGameUniverse 가 구조적으로 영원히
 * complete=false 가 되어 시즌 비교(B/C·E1)가 항상 attendance_only 로 강등된다
 * (2026 실측: 3/1~3/27 27일 전부 failed → 직관 통계 팀 타율·ERA·홈런 영구 미노출).
 * window 미등록 연도는 범위를 즐이지 않는다 — 기존대로 fail-close 된다(추측 서빙 금지).
 */
function getSeasonDates(
  season: number,
  srId = "0,1,3,4,5,7,9",
  todayOverride?: string,
  windowOverride?: RegularSeasonWindow,
): string[] {
  const today = todayOverride ?? new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
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
  if (srId !== REGULAR_ONLY_SR_ID) return dates;
  const window = windowOverride ?? REGULAR_SEASON_WINDOWS[String(season)];
  if (!window) return dates; // 미등록 시즌 — 기존 fail-close 경로 그대로
  // 개막 전은 확정적으로 자른다. 종료일은 성격을 분리한다.
  //   · provisional: 현재월/11월 horizon까지 계속 수집하되 end 뒤는 구조적 failed로 둔다.
  //     고정 lookahead는 더 늦은 순연 경기를 조용히 누락하므로 사용하지 않는다.
  //   · finalized: end가 실제 종료일이므로 그 날짜에서 정확히 자를 수 있다.
  return dates.filter((d) => d >= window.start && (!window.finalized || d <= window.end));
}

/**
 * 정규 전용(srId="0") 우주에서 이 날짜를 "수집 성공"으로 인정할 수 없는가.
 *
 * provisional end는 잔여/순연 일정이 아직 확정되지 않은 경계다. 그 뒤 날짜는
 * 미래/과거, 빈 응답/경기 존재와 무관하게 구조적 미검증으로 둔다. 실제 종료일과
 * finalized=true가 함께 등록된 뒤에만 getSeasonDates가 actual end에서 clip한다.
 */
export function isBeyondVerifiedSeasonEnd(
  date: string,
  srId: string,
  windowOverride?: RegularSeasonWindow,
): boolean {
  if (srId !== REGULAR_ONLY_SR_ID) return false;
  const window = windowOverride ?? REGULAR_SEASON_WINDOWS[date.slice(0, 4)];
  if (!window) return false; // 미등록 연도는 기존 fail-close 경로가 이미 닫는다
  if (date <= window.end) return false;
  // finalized window는 getSeasonDates에서 end 뒤가 제거된다. provisional end 뒤는
  // 과거 verified-empty라도 실제 최종일을 모르는 상태이므로 항상 fail-close한다.
  return !window.finalized;
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
  opts?: { fetcher?: SeasonGameFetcher; today?: string; regularSeasonWindow?: RegularSeasonWindow },
): Promise<SeasonGameCollection> {
  const fetcher = opts?.fetcher ?? fetchSeasonUniverseDate;
  const today = opts?.today ?? new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
  const dates = getSeasonDates(season, srId, today, opts?.regularSeasonWindow);
  const results = await Promise.allSettled(dates.map((d) => fetcher(d, srId)));

  const games: KboGame[] = [];
  const collectedDates: string[] = [];
  const failedDates: string[] = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      failedDates.push(dates[i]);
      return;
    }
    const { games: dateGames, emptyVerified } = r.value;
    // 경기가 실제로 있으면 데이터는 수집한다(end 뒤 순연 경기도 실제 경기다).
    games.push(...dateGames);
    // 삼순 P0 — 종료일 뒤 경계. 자세한 근거는 isBeyondVerifiedSeasonEnd 참조.
    if (isBeyondVerifiedSeasonEnd(dates[i], srId, opts?.regularSeasonWindow)) {
      failedDates.push(dates[i]);
      return;
    }
    // 삼순 P0-1 — unverified soft-empty(빈 배열 + 교차검증 미확정)는 성공 날짜로 세지 않는다.
    // 실제 무경기 확정(emptyVerified) 또는 경기 존재(games>0)만 수집 성공.
    if (dateGames.length === 0 && !emptyVerified) {
      failedDates.push(dates[i]);
      return;
    }
    collectedDates.push(dates[i]);
  });

  return {
    games,
    complete: failedDates.length === 0,
    expectedDates: dates,
    collectedDates,
    failedDates,
  };
}
