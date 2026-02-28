export interface TeamData {
  id: number;
  name: string;
  shortName: string;
  slug: string;
  colorPrimary: string;
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
    colorSecondary: "#1D1D1B",
    logoPath: "/logos/lg.svg",
    youtubeChannelId: "UCWgOCiDVicThVOsRbiBMSLQ",
  },
  {
    id: 2,
    name: "두산 베어스",
    shortName: "두산",
    slug: "doosan",
    colorPrimary: "#131230",
    colorSecondary: "#ED1C24",
    logoPath: "/logos/doosan.svg",
    youtubeChannelId: "UCQbGST4lfDRO27MXfmPejPw",
  },
  {
    id: 3,
    name: "KT 위즈",
    shortName: "KT",
    slug: "kt",
    colorPrimary: "#000000",
    colorSecondary: "#EB1F25",
    logoPath: "/logos/kt.svg",
    youtubeChannelId: "UCwGl_SHd0-3ZN8lGxdiFGIg",
  },
  {
    id: 4,
    name: "SSG 랜더스",
    shortName: "SSG",
    slug: "ssg",
    colorPrimary: "#CE0E2D",
    colorSecondary: "#FFB81C",
    logoPath: "/logos/ssg.svg",
    youtubeChannelId: "UCReA1yNqFD_T8f8ANRO6e4g",
  },
  {
    id: 5,
    name: "NC 다이노스",
    shortName: "NC",
    slug: "nc",
    colorPrimary: "#315288",
    colorSecondary: "#C1A260",
    logoPath: "/logos/nc.svg",
    youtubeChannelId: "UC2sZ1sQaagFtxiB6K7Q8oRg",
  },
  {
    id: 6,
    name: "KIA 타이거즈",
    shortName: "KIA",
    slug: "kia",
    colorPrimary: "#EA0029",
    colorSecondary: "#07101E",
    logoPath: "/logos/kia.svg",
    youtubeChannelId: "UCMRo4CkS27ORz9v3UmMffaQ",
  },
  {
    id: 7,
    name: "롯데 자이언츠",
    shortName: "롯데",
    slug: "lotte",
    colorPrimary: "#002856",
    colorSecondary: "#D00F31",
    logoPath: "/logos/lotte.svg",
    youtubeChannelId: "UCrKGMPyDBh2cGrmYYlTzGqw",
  },
  {
    id: 8,
    name: "삼성 라이온즈",
    shortName: "삼성",
    slug: "samsung",
    colorPrimary: "#074CA1",
    colorSecondary: "#FFFFFF",
    logoPath: "/logos/samsung.svg",
    youtubeChannelId: "UCECVliHxjw5QJLfGnHb0dRg",
  },
  {
    id: 9,
    name: "한화 이글스",
    shortName: "한화",
    slug: "hanwha",
    colorPrimary: "#FF6600",
    colorSecondary: "#1D1D1B",
    logoPath: "/logos/hanwha.svg",
    youtubeChannelId: "UCZXHxO1URqAelMRJJ5jKXlw",
  },
  {
    id: 10,
    name: "키움 히어로즈",
    shortName: "키움",
    slug: "kiwoom",
    colorPrimary: "#820024",
    colorSecondary: "#D4AF37",
    logoPath: "/logos/kiwoom.svg",
    youtubeChannelId: "UCFv2z_bJkR9IR3SVq0HEiYA",
  },
];

export function getTeamById(id: number): TeamData | undefined {
  return TEAMS.find((t) => t.id === id);
}

export function getTeamBySlug(slug: string): TeamData | undefined {
  return TEAMS.find((t) => t.slug === slug);
}
