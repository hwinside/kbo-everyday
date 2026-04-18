/**
 * Design V2 — TEAMS 상수 테이블 (T1.1.4)
 *
 * Spec: specs/design-v2-migration.md (v0.5)
 * Reference: specs/design-v2-reference/redesign/shared/tokens.js
 *
 * ⚠️ slug/id 는 DB team_id 와 동일. 변경 금지.
 * 색상값은 tokens.css 와 동기화 (단, 여기선 JS 런타임 helper 용).
 */

export type TeamSlug =
  | "lg"
  | "doosan"
  | "kt"
  | "ssg"
  | "nc"
  | "kia"
  | "lotte"
  | "samsung"
  | "hanwha"
  | "kiwoom"
  | "neutral";

export interface TeamMeta {
  id: number;
  short: string;
  name: string;
  slug: TeamSlug;
  primary: string;
  light: string;
  secondary: string;
  logo: string;
}

export const TEAMS: Record<TeamSlug, TeamMeta> = {
  lg: {
    id: 1,
    short: "LG",
    name: "LG 트윈스",
    slug: "lg",
    primary: "#C60C30",
    light: "#E04050",
    secondary: "#1D1D1B",
    logo: "/team-logos/lg.svg",
  },
  doosan: {
    id: 2,
    short: "두산",
    name: "두산 베어스",
    slug: "doosan",
    primary: "#131230",
    light: "#9BA8D4",
    secondary: "#ED1C24",
    logo: "/team-logos/doosan.svg",
  },
  kt: {
    id: 3,
    short: "KT",
    name: "KT 위즈",
    slug: "kt",
    primary: "#1A1A1A",
    light: "#E85050",
    secondary: "#EB1F25",
    logo: "/team-logos/kt.svg",
  },
  ssg: {
    id: 4,
    short: "SSG",
    name: "SSG 랜더스",
    slug: "ssg",
    primary: "#CE0E2D",
    light: "#FFB81C",
    secondary: "#FFB81C",
    logo: "/team-logos/ssg.svg",
  },
  nc: {
    id: 5,
    short: "NC",
    name: "NC 다이노스",
    slug: "nc",
    primary: "#315288",
    light: "#7DA3C9",
    secondary: "#C1A260",
    logo: "/team-logos/nc.svg",
  },
  kia: {
    id: 6,
    short: "KIA",
    name: "KIA 타이거즈",
    slug: "kia",
    primary: "#EA0029",
    light: "#D45C5C",
    secondary: "#07101E",
    logo: "/team-logos/kia.svg",
  },
  lotte: {
    id: 7,
    short: "롯데",
    name: "롯데 자이언츠",
    slug: "lotte",
    primary: "#002856",
    light: "#6BC4E8",
    secondary: "#D00F31",
    logo: "/team-logos/lotte.svg",
  },
  samsung: {
    id: 8,
    short: "삼성",
    name: "삼성 라이온즈",
    slug: "samsung",
    primary: "#074CA1",
    light: "#5A8FBD",
    secondary: "#C0C0C0",
    logo: "/team-logos/samsung.svg",
  },
  hanwha: {
    id: 9,
    short: "한화",
    name: "한화 이글스",
    slug: "hanwha",
    primary: "#FF6600",
    light: "#FFA766",
    secondary: "#1D1D1B",
    logo: "/team-logos/hanwha.svg",
  },
  kiwoom: {
    id: 10,
    short: "키움",
    name: "키움 히어로즈",
    slug: "kiwoom",
    primary: "#820024",
    light: "#C97088",
    secondary: "#D4AF37",
    logo: "/team-logos/kiwoom.svg",
  },
  // NEUTRAL = KBO 블루 (삼순이 05:42 추천 채택)
  neutral: {
    id: 0,
    short: "KBO",
    name: "전체 · 중립",
    slug: "neutral",
    primary: "#1E4B8C",
    light: "#4A78B8",
    secondary: "#1E4B8C",
    logo: "/team-logos/lg.svg", // fallback (neutral은 로고 대신 텍스트)
  },
};

export const NEUTRAL_PALETTE = {
  bg0: "#07070A",
  bg1: "#0E0E12",
  bg2: "#15151B",
  bg3: "#1D1D24",
  line: "rgba(255, 255, 255, 0.07)",
  lineStrong: "rgba(255, 255, 255, 0.14)",
  text1: "rgba(255, 255, 255, 0.96)",
  text2: "rgba(255, 255, 255, 0.68)",
  text3: "rgba(255, 255, 255, 0.44)",
  text4: "rgba(255, 255, 255, 0.28)",
  live: "#FF453A",
  win: "#30D158",
  warn: "#FFD60A",
} as const;

/** 팀 slug 로 TeamMeta 조회. 잘못된 값은 neutral 로 fallback. */
export function getTeamBySlug(slug: string | null | undefined): TeamMeta {
  if (!slug) return TEAMS.neutral;
  return TEAMS[slug as TeamSlug] ?? TEAMS.neutral;
}

/** DB team_id 로 TeamMeta 조회. */
export function getTeamById(id: number | null | undefined): TeamMeta {
  if (id == null) return TEAMS.neutral;
  const found = Object.values(TEAMS).find((t) => t.id === id);
  return found ?? TEAMS.neutral;
}
