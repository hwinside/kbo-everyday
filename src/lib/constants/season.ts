export interface RegularSeasonWindow {
  start: string;
  /** 현재 공식 일정으로 확인된 마지막 날짜. finalized=true일 때만 실제 시즌 종료일이다. */
  end: string;
  /** KBO가 우천 순연분까지 포함한 실제 종료일을 확정했는가. */
  finalized: boolean;
}

export const REGULAR_SEASON_WINDOWS: Readonly<Record<string, RegularSeasonWindow>> = {
  // KBO 9/30 발표의 마지막 편성일. 10/13 이후는 계속 fail-close.
  "2026": { start: "20260328", end: "20261012", finalized: false },
};

/** date(YYYYMMDD)가 검증된 정규시즌 window 안인가. 미등록 연도는 false(fail-close). */
export function isWithinRegularSeasonWindow(date: string): boolean {
  const w = REGULAR_SEASON_WINDOWS[date.slice(0, 4)];
  return !!w && date >= w.start && date <= w.end;
}

