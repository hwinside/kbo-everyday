import type { TeamStanding } from "@/lib/types";

export interface RawStanding {
  teamName: string;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  gamesBehind: number;
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

export const MOCK_STANDINGS: TeamStanding[] = [
  { teamId: 7, season: 2026, rank: 1, wins: 85, losses: 56, draws: 3, pct: 0.603, gb: 0, streak: "3연승", last10: "7승3패" },
  { teamId: 9, season: 2026, rank: 2, wins: 83, losses: 57, draws: 4, pct: 0.593, gb: 1.5, streak: "2연승", last10: "6승4패" },
  { teamId: 4, season: 2026, rank: 3, wins: 75, losses: 64, draws: 5, pct: 0.536, gb: 9.5, streak: "1연패", last10: "5승5패" },
  { teamId: 6, season: 2026, rank: 4, wins: 73, losses: 67, draws: 4, pct: 0.521, gb: 12, streak: "1연승", last10: "6승4패" },
  { teamId: 5, season: 2026, rank: 5, wins: 71, losses: 69, draws: 4, pct: 0.507, gb: 14, streak: "2연패", last10: "4승6패" },
  { teamId: 2, season: 2026, rank: 6, wins: 70, losses: 70, draws: 4, pct: 0.500, gb: 15, streak: "1연승", last10: "5승5패" },
  { teamId: 8, season: 2026, rank: 7, wins: 67, losses: 73, draws: 4, pct: 0.479, gb: 18, streak: "3연패", last10: "3승7패" },
  { teamId: 3, season: 2026, rank: 8, wins: 65, losses: 75, draws: 4, pct: 0.464, gb: 20, streak: "1연패", last10: "4승6패" },
  { teamId: 1, season: 2026, rank: 9, wins: 60, losses: 80, draws: 4, pct: 0.429, gb: 25, streak: "2연승", last10: "5승5패" },
  { teamId: 10, season: 2026, rank: 10, wins: 55, losses: 85, draws: 4, pct: 0.393, gb: 30, streak: "4연패", last10: "2승8패" },
];

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
