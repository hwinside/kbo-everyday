/**
 * WCAG AA 대비 계산 유틸 (T1.1.5)
 *
 * Spec: specs/design-v2-migration.md (v0.5)
 * Plan §2.2: AA 대비 CI 블로킹 스크립트 의존
 *
 * 참고: https://www.w3.org/TR/WCAG21/#contrast-minimum
 */

import { luminance as hexLuminance } from "@/design-v2/team-palette";

/**
 * 두 hex 색상 간 대비비 계산.
 * 반환값 1.0 (동일) ~ 21.0 (흑백 최대).
 * AA large: ≥ 3.0, AA normal: ≥ 4.5, AAA: ≥ 7.0.
 */
export function contrastRatio(a: string, b: string): number {
  const la = hexLuminance(a);
  const lb = hexLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export type ContrastLevel = "AAA" | "AA" | "AA-large" | "fail";

/** 계산된 ratio 를 WCAG 등급으로 분류. */
export function classify(ratio: number): ContrastLevel {
  if (ratio >= 7.0) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3.0) return "AA-large";
  return "fail";
}

/** fg/bg 쌍이 최소 AA (4.5:1) 를 만족하는지 */
export function meetsAA(fg: string, bg: string): boolean {
  return contrastRatio(fg, bg) >= 4.5;
}

/** fg/bg 쌍이 AA-large (3.0:1) 를 만족하는지 — 18pt+ 또는 14pt bold 텍스트용 */
export function meetsAALarge(fg: string, bg: string): boolean {
  return contrastRatio(fg, bg) >= 3.0;
}

/**
 * onAccent 자동 선택: 배경 색 위에 흑/백 중 대비 좋은 쪽.
 * team-palette.ts 와 일관된 로직.
 */
export function pickOnAccent(bg: string): "#ffffff" | "#0a0a0a" {
  const bgLum = hexLuminance(bg);
  return bgLum > 0.5 ? "#0a0a0a" : "#ffffff";
}
