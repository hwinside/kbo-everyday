export interface RegularSeasonWindow {
  start: string;
  /** 현재 공식 일정으로 확인된 마지막 날짜. finalized=true일 때만 실제 시즌 종료일이다. */
  end: string;
  /** KBO가 우천 순연분까지 포함한 실제 종료일을 확정했는가. */
  finalized: boolean;
}

export const REGULAR_SEASON_WINDOWS: Readonly<Record<string, RegularSeasonWindow>> = {
  // 2026-10-13 확인: 10/12 정규 종료, 10/14 WC 등록. 정규 통계 모수 확정.
  "2026": { start: "20260328", end: "20261012", finalized: true },
};

/** Final labels apply only after the explicitly confirmed end date in KST. */
export function isRegularSeasonFinal(now = new Date()): boolean {
  const date = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).replaceAll("-", "");
  const window = REGULAR_SEASON_WINDOWS[date.slice(0, 4)];
  return !!window?.finalized && date > window.end;
}
