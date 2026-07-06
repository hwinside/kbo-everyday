export interface TeamData {
  id: number;
  name: string;
  shortName: string;
  slug: string;
  colorPrimary: string;
  colorLight: string;
  colorSecondary: string;
  /** 뱃지 배경색 오버라이드. 테마별 값 + 선택적 보더.
   *  colorPrimary가 다크에서 묻히거나 라이트에서 너무 눈에 튀는 팀에 적용. */
  colorBadgeOverride?: {
    dark: string;
    light: string;
    /** 다크 모드 1px 외근 보더 (속/배경 대비 부족 보강). */
    borderDark?: string;
    /** 라이트 모드 1px 외근 보더. */
    borderLight?: string;
  };
  logoPath: string;
  youtubeChannelId: string;
}

export const TEAMS: TeamData[] = [
  {
    id: 1,
    name: "LG 트윈스",
    shortName: "LG",
    slug: "lg",
    colorPrimary: "#C60C30",
    colorLight: "#E04050",
    colorSecondary: "#1D1D1B",
    logoPath: "/logos/lg.svg",
    youtubeChannelId: "UCL6QZZxb-HR4hCh_eFAnQWA",
  },
  {
    id: 2,
    name: "두산 베어스",
    shortName: "두산",
    slug: "doosan",
    colorPrimary: "#131230",
    colorLight: "#9BA8D4",
    colorSecondary: "#ED1C24",
    logoPath: "/logos/doosan.svg",
    youtubeChannelId: "UCsebzRfMhwYfjeBIxNX1brg",
  },
  {
    id: 3,
    name: "KT 위즈",
    shortName: "KT",
    slug: "kt",
    colorPrimary: "#000000",
    colorLight: "#E85050",
    colorSecondary: "#EB1F25",
    // KT 팀컬러(#000) 가독성 보정:
    // - 다크: colorLight(#E85050) + 1px 밝은 보더 (칩 경계 보강)
    // - 라이트: 진회색(#2B2B2B, 2026-04-21 하린아빠 "잘 보임" 상태 유지), 보더 없음
    colorBadgeOverride: {
      dark: "#E85050",
      light: "#2B2B2B",
      borderDark: "rgba(255,255,255,0.18)",
    },
    logoPath: "/logos/kt.svg",
    youtubeChannelId: "UCvScyjGkBUx2CJDMNAi9Twg",
  },
  {
    id: 4,
    name: "SSG 랜더스",
    shortName: "SSG",
    slug: "ssg",
    colorPrimary: "#CE0E2D",
    colorLight: "#D4A76A",
    colorSecondary: "#FFB81C",
    logoPath: "/logos/ssg.svg",
    youtubeChannelId: "UCt8iRtgjVqm5rJHNl1TUojg",
  },
  {
    id: 5,
    name: "NC 다이노스",
    shortName: "NC",
    slug: "nc",
    colorPrimary: "#315288",
    colorLight: "#7DA3C9",
    colorSecondary: "#C1A260",
    logoPath: "/logos/nc.svg",
    youtubeChannelId: "UC8_FRgynMX8wlGsU6Jh3zKg",
  },
  {
    id: 6,
    name: "KIA 타이거즈",
    shortName: "KIA",
    slug: "kia",
    colorPrimary: "#EA0029",
    colorLight: "#D45C5C",
    colorSecondary: "#07101E",
    logoPath: "/logos/kia.svg",
    youtubeChannelId: "UCKp8knO8a6tSI1oaLjfd9XA",
  },
  {
    id: 7,
    name: "롯데 자이언츠",
    shortName: "롯데",
    slug: "lotte",
    colorPrimary: "#002856",
    colorLight: "#6BC4E8",
    colorSecondary: "#D00F31",
    logoPath: "/logos/lotte.svg",
    youtubeChannelId: "UCAZQZdSY5_YrziMPqXi-Zfw",
  },
  {
    id: 8,
    name: "삼성 라이온즈",
    shortName: "삼성",
    slug: "samsung",
    colorPrimary: "#074CA1",
    colorLight: "#5A8FBD",
    colorSecondary: "#FFFFFF",
    logoPath: "/logos/samsung.svg",
    youtubeChannelId: "UCMWAku3a3h65QpLm63Jf2pw",
  },
  {
    id: 9,
    name: "한화 이글스",
    shortName: "한화",
    slug: "hanwha",
    colorPrimary: "#FF6600",
    colorLight: "#E8A06A",
    colorSecondary: "#1D1D1B",
    logoPath: "/logos/hanwha.svg",
    youtubeChannelId: "UCdq4Ji3772xudYRUatdzRrg",
  },
  {
    id: 10,
    name: "키움 히어로즈",
    shortName: "키움",
    slug: "kiwoom",
    colorPrimary: "#820024",
    colorLight: "#C97088",
    colorSecondary: "#D4AF37",
    logoPath: "/logos/kiwoom.svg",
    youtubeChannelId: "UC_MA8-XEaVmvyayPzG66IKg",
  },
];

/** 올스타전(나눔/드림) 팀. 정규 10구단 목록(TEAMS)과 의도적으로 분리한다 —
 *  팀 선택·순위표 등 TEAMS를 순회하는 UI에 올스타가 섞이면 안 되므로,
 *  id 조회(getTeamById)에서만 해석되도록 별도 레지스트리로 둔다. */
export const ALLSTAR_NANUM_ID = 101;
export const ALLSTAR_DREAM_ID = 102;

const ALLSTAR_TEAMS: TeamData[] = [
  {
    id: ALLSTAR_NANUM_ID,
    name: "나눔 올스타",
    shortName: "나눔",
    slug: "allstar-nanum",
    colorPrimary: "#002539",
    colorLight: "#5E8CB8",
    colorSecondary: "#1D1D1B",
    logoPath: "/logos/allstar-nanum.svg",
    youtubeChannelId: "",
  },
  {
    id: ALLSTAR_DREAM_ID,
    name: "드림 올스타",
    shortName: "드림",
    slug: "allstar-dream",
    colorPrimary: "#2E86C9",
    colorLight: "#98C5E3",
    colorSecondary: "#1D1D1B",
    logoPath: "/logos/allstar-dream.svg",
    youtubeChannelId: "",
  },
];

/** KBO 올스타 팀 코드 → id. gameId·스케줄 코드가 정규 팀맵에 없을 때 사용.
 *  (2026 올스타 gameId "…WEEA0" 기준 WE=나눔 / EA=드림) */
export const ALLSTAR_CODE_TO_ID: Record<string, number> = {
  WE: ALLSTAR_NANUM_ID,
  EA: ALLSTAR_DREAM_ID,
};

/** 팀명(나눔/드림)으로 올스타 id 해석. 2자 코드가 시즌마다 바뀌어도
 *  팀명은 안정적이라 크롤러 폴백으로 쓴다. */
export function allstarTeamIdByName(name: string | null | undefined): number | undefined {
  if (!name) return undefined;
  if (name.includes("나눔")) return ALLSTAR_NANUM_ID;
  if (name.includes("드림")) return ALLSTAR_DREAM_ID;
  return undefined;
}

export function isAllStarTeamId(id: number): boolean {
  return id === ALLSTAR_NANUM_ID || id === ALLSTAR_DREAM_ID;
}

/** 올스타전 경기 여부(팀 id 기반). AI 분석·승부예측 등 팀기반 기능 게이팅용. */
export function isAllStarGame(awayTeamId: number, homeTeamId: number): boolean {
  return isAllStarTeamId(awayTeamId) || isAllStarTeamId(homeTeamId);
}

/** KBO gameId("…WEEA0")의 2자 팀 코드로 올스타전 판정. teamId 해석 전 단계용. */
export function isAllStarGameId(gameId: string): boolean {
  const m = gameId.match(/^\d{8}([A-Z]{2})([A-Z]{2})\d$/);
  if (!m) return false;
  return ALLSTAR_CODE_TO_ID[m[1]] !== undefined || ALLSTAR_CODE_TO_ID[m[2]] !== undefined;
}

export function getTeamById(id: number): TeamData | undefined {
  return TEAMS.find((t) => t.id === id) ?? ALLSTAR_TEAMS.find((t) => t.id === id);
}

export function getTeamBySlug(slug: string): TeamData | undefined {
  return TEAMS.find((t) => t.slug === slug);
}

/**
 * hex → relative luminance (0~1).
 * 0 = black, 1 = white.
 */
function hexLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** 팀 뱃지 배경색. 테마 인식.
 *  1) colorBadgeOverride가 있으면 테마별 값
 *  2) 다크에서 colorPrimary가 너무 어두우면(luminance < 0.05) colorLight
 *  3) 그 외는 colorPrimary
 */
export function getTeamBgColor(team: TeamData, resolvedTheme: "dark" | "light" = "dark"): string {
  if (team.colorBadgeOverride) {
    return resolvedTheme === "light" ? team.colorBadgeOverride.light : team.colorBadgeOverride.dark;
  }
  if (resolvedTheme === "dark" && hexLuminance(team.colorPrimary) < 0.05) {
    return team.colorLight;
  }
  return team.colorPrimary;
}

/** 팀 뱃지 외근 보더. override에 보더 지정이 있을 때만 반환. */
export function getTeamBgBorder(team: TeamData, resolvedTheme: "dark" | "light" = "dark"): string | undefined {
  const ov = team.colorBadgeOverride;
  if (!ov) return undefined;
  return resolvedTheme === "light" ? ov.borderLight : ov.borderDark;
}

/** 다크모드 바 차트용 팀 컬러.
 *  colorLight를 기본으로 사용 (다크 배경에서 가시성 보장).
 */
export function getTeamBarColor(team: TeamData): string {
  return team.colorLight;
}

/** hex → hue (0~360) */
function hexToHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = Math.round(h * 60);
  return h < 0 ? h + 360 : h;
}

/** 두 팀의 바 차트 색상 쌍을 반환.
 *  colorLight 기반, hue 차이 < 40° 이면 home을 colorSecondary로 교체.
 */
export function getCompareBarColors(away: TeamData, home: TeamData, isDark = true): [string, string] {
  const awayColor = isDark ? away.colorLight : away.colorPrimary;
  let homeColor = isDark ? home.colorLight : home.colorPrimary;

  const awayHue = hexToHue(awayColor);
  const homeHue = hexToHue(homeColor);
  const hueDiff = Math.abs(awayHue - homeHue);
  const hueDistance = Math.min(hueDiff, 360 - hueDiff);

  if (hueDistance < 40) {
    // 유사색 → home을 secondary로 교체
    if (home.colorSecondary && hexLuminance(home.colorSecondary) >= 0.05) {
      // secondary도 유사한지 체크
      const secHue = hexToHue(home.colorSecondary);
      const secDiff = Math.min(Math.abs(awayHue - secHue), 360 - Math.abs(awayHue - secHue));
      if (secDiff >= 40) {
        homeColor = home.colorSecondary;
      } else {
        // secondary도 유사 → 중립 그레이 사용
        homeColor = "#A0A0A0";
      }
    } else {
      // secondary가 너무 어두움 → 중립 그레이
      homeColor = "#A0A0A0";
    }
  }

  return [awayColor, homeColor];
}
