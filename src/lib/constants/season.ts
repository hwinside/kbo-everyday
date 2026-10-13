export interface RegularSeasonWindow {
  start: string;
  /** 현재 공식 일정으로 확인된 마지막 날짜. finalized=true일 때만 실제 시즌 종료일이다. */
  end: string;
  /** KBO가 우천 순연분까지 포함한 실제 종료일을 확정했는가. */
  finalized: boolean;
}

export const REGULAR_SEASON_WINDOWS: Readonly<Record<string, RegularSeasonWindow>> = {
  // 2026-10-13 확인: 정규 종료 10/12, WC 10/14 등록.
  "2026": { start: "20260328", end: "20261012", finalized: true },
};

/** date(YYYYMMDD)가 검증된 정규시즌 window 안인가. 미등록 연도는 false(fail-close). */
export function isWithinRegularSeasonWindow(date: string): boolean {
  const w = REGULAR_SEASON_WINDOWS[date.slice(0, 4)];
  return !!w && date >= w.start && date <= w.end;
}


/** Final labels apply only after the explicitly confirmed end date in KST. */
export function isRegularSeasonFinal(
  now = new Date(),
  windows: Readonly<Record<string, RegularSeasonWindow>> = REGULAR_SEASON_WINDOWS,
): boolean {
  const date = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).replaceAll("-", "");
  const window = windows[date.slice(0, 4)];
  return !!window?.finalized && date > window.end;
}

/** 2026 season picks close with the confirmed regular season; unknown seasons stay closed. */
export function seasonPredictionsOpen(season: number, now = new Date()): boolean {
  const window = REGULAR_SEASON_WINDOWS[String(season)];
  if (!window) return false;
  const date = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).replaceAll("-", "");
  return date >= window.start && date <= window.end;
}
