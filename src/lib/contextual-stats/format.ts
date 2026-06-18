import type { SplitRow } from "./types";

/**
 * Inline 보조 텍스트(AVG 옆 작은 글씨)를 만든다.
 *
 * 타자: 실제 타수(AB)가 있으므로 "43타수 19안타".
 * 투수: KBO Situation 표에 *실제 타수(AB) 컬럼이 없다*. SplitRow.AB는
 *   H+BB+SO로 만든 표본 추정치(over-estimate)일 뿐이라 "타수"로 노출하면
 *   피안타율과 모순된다(예: .226인데 43타수 19안타=.442처럼 보임). 따라서
 *   투수는 타수를 숨기고 피안타(H)만 정직하게 표시한다.
 *
 * See situation-parser.ts(rowToSplitRow) — pitcher AB is a sample-size proxy.
 */
export function formatSplitInline(row: SplitRow, isPitcher: boolean): string {
  const hr = row.HR > 0 ? ` (${row.HR}HR)` : "";
  if (isPitcher) {
    return `${row.H}피안타${hr}`;
  }
  return `${row.AB}타수 ${row.H}안타${hr}`;
}
