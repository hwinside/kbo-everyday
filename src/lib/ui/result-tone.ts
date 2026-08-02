/**
 * 승패·긍정/부정 표시 색 SSOT.
 *
 * 2026-08-02 하린아빠 지시: "승패, 긍정/부정 등에 쓰이는 컬러톤이 다 제각각이야.
 * 홈에 쓰인 승패, 등록말소와 같은 컬러톤으로 통일해줘".
 *
 * 기준값(base) = 홈 팀카드 `최근 N경기` 칩(승 초록 / 패 빨강 / 무 회색).
 * 팀 페이지 `등록·말소` 배지도 같은 계열이라 이 값으로 수렴시킨다.
 *
 * ⚠️ 화면마다 색을 다시 적지 말 것. 새 승패/증감/긍부정 표시는 여기서 가져다 쓴다.
 *
 * variant 가 두 종류인 이유(추측 아님 — 실측):
 *  - `base` 는 중성 다크 배경(#0A0A0B·#151519) 기준으로 AA 4.5:1 을 넘는다.
 *  - 직관 통계 히어로처럼 **배경 자체가 붉은 그라데이션**인 카드 위에서는 base 빨강이
 *    3.69:1 로 떨어져 `qa:venue-stats-s2-browser` 대비 게이트가 FAIL 한다(실측).
 *    그래서 색상 계열은 유지한 채 명도만 올린 `soft` 를 둔다. 임의 팔레트가 아니라
 *    같은 hue 의 밝은 단계이며, 히어로 카드가 이미 쓰던 톤(#ff9aa5)과 같은 계열이다.
 * 배경이 유채색이면 `soft`, 그 외에는 `base` 를 쓴다.
 */

export type ResultTone = "positive" | "negative" | "neutral";
export type ResultToneVariant = "base" | "soft";

/** 텍스트·아이콘 색 */
export const RESULT_TONE_COLOR: Record<ResultTone, string> = {
  positive: "#36D399",
  negative: "#FF6B6B",
  neutral: "#B0B0BA",
};

/** 유채색(붉은/짙은 컬러) 배경 위에서 쓰는 밝은 단계 — 같은 계열, 명도만 상향. */
export const RESULT_TONE_COLOR_SOFT: Record<ResultTone, string> = {
  positive: "#6EE7B7",
  negative: "#FF9AA5",
  neutral: "#C9C9D4",
};

/** 칩·배지 배경(홈 팀카드 칩 실측값) */
export const RESULT_TONE_BG: Record<ResultTone, string> = {
  positive: "rgba(38,168,109,0.22)",
  negative: "rgba(196,1,47,0.20)",
  neutral: "rgba(160,160,170,0.18)",
};

/** 테두리(옅은 라인이 필요한 배지용) */
export const RESULT_TONE_BORDER: Record<ResultTone, string> = {
  positive: "rgba(54,211,153,0.40)",
  negative: "rgba(255,107,107,0.40)",
  neutral: "rgba(176,176,186,0.30)",
};

function toneColor(tone: ResultTone, variant: ResultToneVariant): string {
  return variant === "soft" ? RESULT_TONE_COLOR_SOFT[tone] : RESULT_TONE_COLOR[tone];
}

/** 경기 결과 코드 → tone. 무승부·미정은 중립. */
export function gameResultTone(result: "W" | "L" | "D" | null | undefined): ResultTone {
  if (result === "W") return "positive";
  if (result === "L") return "negative";
  return "neutral";
}

/** 텍스트 전용 inline style */
export function resultToneTextStyle(
  tone: ResultTone,
  variant: ResultToneVariant = "base",
): { color: string } {
  return { color: toneColor(tone, variant) };
}

/** 칩/배지(배경+텍스트) inline style */
export function resultToneChipStyle(
  tone: ResultTone,
  variant: ResultToneVariant = "base",
): { color: string; backgroundColor: string } {
  return { color: toneColor(tone, variant), backgroundColor: RESULT_TONE_BG[tone] };
}

/** 테두리까지 필요한 배지 inline style */
export function resultToneOutlineStyle(
  tone: ResultTone,
  variant: ResultToneVariant = "base",
): { color: string; backgroundColor: string; borderColor: string } {
  return {
    color: toneColor(tone, variant),
    backgroundColor: RESULT_TONE_BG[tone],
    borderColor: RESULT_TONE_BORDER[tone],
  };
}
