/**
 * Design V2 — Team Palette Helpers (T1.1.3)
 *
 * Spec: specs/design-v2-migration.md (v0.5)
 * Reference: specs/design-v2-reference/redesign/shared/tokens.js (FROZEN)
 *
 * reference tokens.js 의 4 helper 를 TS 로 1:1 포팅:
 *   - mix(a, b, t)
 *   - withAlpha(hex, a)
 *   - luminance(hex)
 *   - teamPalette(team, intensity=6)
 *
 * 이 모듈은 *순수 함수*. DOM / React 의존 없음. 단위 테스트 용이.
 */

import { type TeamMeta, NEUTRAL_PALETTE, TEAMS } from "./TEAMS";

/**
 * 두 hex 색상을 비율 t (0~1) 로 선형 보간.
 * mix('#000000', '#ffffff', 0.5) === '#808080'
 */
export function mix(a: string, b: string, t: number): string {
  const pa: [number, number, number] = [
    parseInt(a.slice(1, 3), 16),
    parseInt(a.slice(3, 5), 16),
    parseInt(a.slice(5, 7), 16),
  ];
  const pb: [number, number, number] = [
    parseInt(b.slice(1, 3), 16),
    parseInt(b.slice(3, 5), 16),
    parseInt(b.slice(5, 7), 16),
  ];
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return (
    "#" +
    [r, g, bl].map((x) => x.toString(16).padStart(2, "0")).join("")
  );
}

/** hex 색상에 alpha 적용 → rgba(...) 문자열. */
export function withAlpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * 상대 휘도 (WCAG) 계산. 0 ~ 1.
 * 어두운 팀 컬러 감지 / 저채도 판별에 사용.
 */
export function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** accent 배경 위에서 흑/백 중 WCAG 대비가 더 높은 텍스트 색을 선택. */
export function onAccentColor(hex: string): "#ffffff" | "#0a0a0a" {
  const bg = luminance(hex);
  const whiteContrast = 1.05 / (bg + 0.05);
  const blackLuminance = luminance("#0a0a0a");
  const blackContrast = (bg + 0.05) / (blackLuminance + 0.05);
  return blackContrast > whiteContrast ? "#0a0a0a" : "#ffffff";
}

/**
 * 어두운 팀 primary 는 light 를 대신 쓰도록 결정.
 * 두산/KT/KIA 검정~짙은 남색 계열 보정용.
 */
export function onDarkColor(team: TeamMeta): string {
  return luminance(team.primary) < 0.06 ? team.light : team.primary;
}

export interface TeamPalette {
  /** 실제 사용할 accent (primary 또는 light 중 WCAG 기반 선택) */
  base: string;
  /** 원본 팀 primary */
  primary: string;
  /** 원본 팀 secondary */
  secondary: string;
  /** 원본 팀 light */
  light: string;
  /** hero 배경 그라데이션 시작 */
  heroBgA: string;
  /** hero 배경 그라데이션 끝 */
  heroBgB: string;
  /** 페이지 전체 은은한 ambient */
  ambient: string;
  /** 카드 살짝 tint */
  cardTint: string;
  /** 강조 버튼 배경 (accent 자체) */
  accent: string;
  /** 약한 강조 배경 (accent + alpha) */
  accentSoft: string;
  /** accent 테두리 */
  accentBorder: string;
  /** accent 배경 위 텍스트 색 (명도 기준 자동 선택) */
  onAccent: string;
  /** true 면 중립 팔레트. 저채도 팀 fallback 경로 확인용. */
  isNeutral: boolean;
}

/**
 * 팀 테마 팔레트 생성. intensity 0~10 (기본 6).
 * reference tokens.js teamPalette() 와 동일한 수식.
 */
export function teamPalette(
  team: TeamMeta,
  intensity: number = 6,
): TeamPalette {
  const t = Math.max(0, Math.min(1, intensity / 10));

  // 중립 테마: KBO 블루 accent + 중립 palette
  if (team.slug === "neutral") {
    const accent = team.primary; // #1E4B8C (KBO 블루)
    return {
      base: accent,
      primary: accent,
      secondary: team.secondary,
      light: team.light,
      heroBgA: mix(NEUTRAL_PALETTE.bg1, accent, 0.08),
      heroBgB: mix(NEUTRAL_PALETTE.bg0, accent, 0.03),
      ambient: withAlpha(accent, 0.06),
      cardTint: mix(NEUTRAL_PALETTE.bg2, accent, 0.02),
      accent,
      accentSoft: withAlpha(accent, 0.14),
      accentBorder: withAlpha(accent, 0.32),
      onAccent: "#ffffff",
      isNeutral: true,
    };
  }

  // 일반 팀: 저채도 팀은 light 로 대체 (onDarkColor)
  const base = onDarkColor(team);

  // 저채도 팀 (두산/KT/KIA 등) 은 softAlpha 를 조금 높여 가독성 확보
  const darkTeam = luminance(team.primary) < 0.06;
  const softAlpha = darkTeam ? 0.18 + 0.1 * t : 0.14 + 0.1 * t;
  const borderAlpha = darkTeam ? 0.36 + 0.1 * t : 0.32 + 0.1 * t;

  return {
    base,
    primary: team.primary,
    secondary: team.secondary,
    light: team.light,
    heroBgA: mix(NEUTRAL_PALETTE.bg1, base, 0.1 + 0.35 * t),
    heroBgB: mix(NEUTRAL_PALETTE.bg0, base, 0.0 + 0.15 * t),
    ambient: withAlpha(base, 0.08 + 0.1 * t),
    cardTint: mix(NEUTRAL_PALETTE.bg2, base, 0.02 + 0.12 * t),
    accent: base,
    accentSoft: withAlpha(base, softAlpha),
    accentBorder: withAlpha(base, borderAlpha),
    onAccent: onAccentColor(base),
    isNeutral: false,
  };
}

/**
 * 편의 함수: DB team_id(숫자)로 바로 팔레트 생성 — 팀색 강조 UI 공용 helper.
 * 팀 CSS 변수 직접 사용 금지 계약의 진입점: accent/onAccent 가 WCAG AA 를 보장한다.
 * 미매칭/null 은 neutral(KBO 블루) fallback.
 */
export function paletteForTeamId(
  teamId: number | null | undefined,
  intensity: number = 6,
): TeamPalette {
  const team =
    teamId != null ? Object.values(TEAMS).find((t) => t.id === teamId) : undefined;
  return teamPalette(team ?? TEAMS.neutral, intensity);
}

/** 편의 함수: slug 문자열로 바로 팔레트 생성. */
export function paletteForSlug(
  slug: string | null | undefined,
  intensity: number = 6,
): TeamPalette {
  const team = slug && slug in TEAMS ? TEAMS[slug as keyof typeof TEAMS] : TEAMS.neutral;
  return teamPalette(team, intensity);
}
