import type { TeamStanding } from "@/lib/types";

export interface RawStanding {
  teamName: string;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  gamesBehind: number;
  /** 네이버 API continuousGameResult (예: "3승", "1패") */
  continuousGameResult?: string;
}

export interface RealBatterStat {
  name: string;
  team: string;
  rank: number;
  pa?: number;
  games?: number;
  avg?: string;
  hr?: string;
  rbi?: string;
  hits?: string;
  sb?: string;
  ops?: string;
  obp?: string;
  slg?: string;
  [key: string]: string | number | undefined;
}

export interface RealPitcherStat {
  name: string;
  team: string;
  rank: number;
  ip?: number;
  games?: number;
  era?: string;
  wins?: string;
  so?: string;
  saves?: string;
  holds?: string;
  whip?: string;
  [key: string]: string | number | undefined;
}

export type TitleCategory = "avg" | "hr" | "rbi" | "hits" | "sb" | "wins" | "era" | "so" | "saves" | "holds";

export interface TitleLeader {
  rank: number;
  name: string;
  teamId: number;
  playerId?: string;
  value: string;
}

export type MainTab = "team" | "batter" | "pitcher";

export const TEAM_NAME_TO_ID: Record<string, number> = {
  "LG": 1, "두산": 2, "KT": 3, "SSG": 4, "NC": 5,
  "KIA": 6, "롯데": 7, "삼성": 8, "한화": 9, "키움": 10,
};

/** 2025 정규시즌 최종 순위 (확정) */
export const STANDINGS_2025: TeamStanding[] = [
  { teamId: 1,  season: 2025, rank: 1,  wins: 85, losses: 56, draws: 3, pct: 0.603, gb: 0,    streak: "", last10: "" },
  { teamId: 9,  season: 2025, rank: 2,  wins: 83, losses: 57, draws: 4, pct: 0.593, gb: 1.5,  streak: "", last10: "" },
  { teamId: 4,  season: 2025, rank: 3,  wins: 75, losses: 65, draws: 4, pct: 0.536, gb: 9.5,  streak: "", last10: "" },
  { teamId: 8,  season: 2025, rank: 4,  wins: 74, losses: 68, draws: 2, pct: 0.521, gb: 11.5, streak: "", last10: "" },
  { teamId: 5,  season: 2025, rank: 5,  wins: 71, losses: 67, draws: 6, pct: 0.514, gb: 12.5, streak: "", last10: "" },
  { teamId: 3,  season: 2025, rank: 6,  wins: 71, losses: 68, draws: 5, pct: 0.511, gb: 13,   streak: "", last10: "" },
  { teamId: 7,  season: 2025, rank: 7,  wins: 66, losses: 72, draws: 6, pct: 0.478, gb: 17.5, streak: "", last10: "" },
  { teamId: 6,  season: 2025, rank: 8,  wins: 65, losses: 75, draws: 4, pct: 0.464, gb: 19.5, streak: "", last10: "" },
  { teamId: 2,  season: 2025, rank: 9,  wins: 61, losses: 77, draws: 6, pct: 0.442, gb: 22.5, streak: "", last10: "" },
  { teamId: 10, season: 2025, rank: 10, wins: 47, losses: 93, draws: 4, pct: 0.336, gb: 37.5, streak: "", last10: "" },
];

export const MOCK_STANDINGS: TeamStanding[] = STANDINGS_2025;

export const BATTER_TITLES: { id: TitleCategory; label: string; leaders: TitleLeader[] }[] = [
  { id: "avg", label: "타율", leaders: [
    { rank: 1, name: "구자욱", teamId: 8, value: ".348", playerId: "62404" },
    { rank: 2, name: "오스틴", teamId: 1, value: ".341", playerId: "53123" },
    { rank: 3, name: "김도영", teamId: 6, value: ".335", playerId: "52605" },
    { rank: 4, name: "나성범", teamId: 3, value: ".328", playerId: "62947" },
    { rank: 5, name: "이정후", teamId: 10, value: ".322", playerId: "67341" },
  ]},
  { id: "hr", label: "홈런", leaders: [
    { rank: 1, name: "오스틴", teamId: 1, value: "35", playerId: "53123" },
    { rank: 2, name: "페르난데스", teamId: 4, value: "32", playerId: "54400" },
    { rank: 3, name: "김도영", teamId: 6, value: "28", playerId: "52605" },
    { rank: 4, name: "나성범", teamId: 3, value: "25", playerId: "62947" },
    { rank: 5, name: "최형우", teamId: 6, value: "23", playerId: "72443" },
  ]},
  { id: "rbi", label: "타점", leaders: [
    { rank: 1, name: "오스틴", teamId: 1, value: "108", playerId: "53123" },
    { rank: 2, name: "김도영", teamId: 6, value: "98", playerId: "52605" },
    { rank: 3, name: "페르난데스", teamId: 4, value: "95", playerId: "54400" },
    { rank: 4, name: "구자욱", teamId: 8, value: "87", playerId: "62404" },
    { rank: 5, name: "김하성", teamId: 2, value: "82", playerId: "64300" },
  ]},
  { id: "hits", label: "안타", leaders: [
    { rank: 1, name: "구자욱", teamId: 8, value: "178", playerId: "62404" },
    { rank: 2, name: "김도영", teamId: 6, value: "172", playerId: "52605" },
    { rank: 3, name: "이정후", teamId: 10, value: "168", playerId: "67341" },
    { rank: 4, name: "오스틴", teamId: 1, value: "165", playerId: "53123" },
    { rank: 5, name: "나성범", teamId: 3, value: "158", playerId: "62947" },
  ]},
  { id: "sb", label: "도루", leaders: [
    { rank: 1, name: "김도영", teamId: 6, value: "42", playerId: "52605" },
    { rank: 2, name: "이정후", teamId: 10, value: "28", playerId: "67341" },
    { rank: 3, name: "박동원", teamId: 1, value: "22", playerId: "76305" },
    { rank: 4, name: "한석현", teamId: 7, value: "20", playerId: "51897" },
    { rank: 5, name: "김하성", teamId: 2, value: "18", playerId: "64300" },
  ]},
];

export const PITCHER_TITLES: { id: TitleCategory; label: string; leaders: TitleLeader[] }[] = [
  { id: "era", label: "평균자책", leaders: [
    { rank: 1, name: "양현종", teamId: 6, value: "2.45", playerId: "75645" },
    { rank: 2, name: "안우진", teamId: 6, value: "2.68", playerId: "68341" },
    { rank: 3, name: "문동주", teamId: 9, value: "2.87", playerId: "51344" },
    { rank: 4, name: "소형준", teamId: 5, value: "3.12", playerId: "50662" },
    { rank: 5, name: "이의리", teamId: 2, value: "3.24", playerId: "51648" },
  ]},
  { id: "wins", label: "다승", leaders: [
    { rank: 1, name: "안우진", teamId: 6, value: "16", playerId: "68341" },
    { rank: 2, name: "양현종", teamId: 6, value: "15", playerId: "75645" },
    { rank: 3, name: "소형준", teamId: 5, value: "14", playerId: "50662" },
    { rank: 4, name: "문동주", teamId: 9, value: "13", playerId: "51344" },
    { rank: 5, name: "이의리", teamId: 2, value: "12", playerId: "51648" },
  ]},
  { id: "so", label: "탈삼진", leaders: [
    { rank: 1, name: "안우진", teamId: 6, value: "198", playerId: "68341" },
    { rank: 2, name: "문동주", teamId: 9, value: "185", playerId: "51344" },
    { rank: 3, name: "소형준", teamId: 5, value: "172", playerId: "50662" },
    { rank: 4, name: "이의리", teamId: 2, value: "164", playerId: "51648" },
    { rank: 5, name: "양현종", teamId: 6, value: "148", playerId: "75645" },
  ]},
  { id: "saves", label: "세이브", leaders: [
    { rank: 1, name: "정우영", teamId: 1, value: "38", playerId: "69159" },
    { rank: 2, name: "박영현", teamId: 6, value: "34", playerId: "50106" },
    { rank: 3, name: "고우석", teamId: 2, value: "31", playerId: "67119" },
    { rank: 4, name: "이승현", teamId: 8, value: "28", playerId: "51454" },
    { rank: 5, name: "조상우", teamId: 3, value: "25", playerId: "50859" },
  ]},
  { id: "holds", label: "홀드", leaders: [
    { rank: 1, name: "김진욱", teamId: 9, value: "28", playerId: "51111" },
    { rank: 2, name: "최원준", teamId: 4, value: "25", playerId: "51104" },
    { rank: 3, name: "진해수", teamId: 1, value: "22", playerId: "50030" },
    { rank: 4, name: "김재열", teamId: 5, value: "20", playerId: "67449" },
    { rank: 5, name: "임기영", teamId: 2, value: "18", playerId: "62234" },
  ]},
];
