export interface TeamData {
  id: number;
  name: string;
  shortName: string;
  slug: string;
  colorPrimary: string;
  colorLight: string;
  colorSecondary: string;
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

export function getTeamById(id: number): TeamData | undefined {
  return TEAMS.find((t) => t.id === id);
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

/** 다크모드 배경에서 사용할 팀 컬러.
 *  colorPrimary가 너무 어두우면(luminance < 0.05) colorLight를 반환.
 */
export function getTeamBgColor(team: TeamData): string {
  return hexLuminance(team.colorPrimary) < 0.05 ? team.colorLight : team.colorPrimary;
}
