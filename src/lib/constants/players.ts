import type { Player, PlayerSeasonStats } from "@/lib/types";

/* ===== LG 트윈스 주전 라인업 (목업) ===== */
export const LG_BATTERS: (Player & { seasonStats: PlayerSeasonStats })[] = [
  {
    id: 101, teamId: 1, name: "오스틴", nameEn: "Austin", number: 33,
    position: "DH", throwsBats: "우투우타", birthDate: "1993-06-15", photoUrl: null, isActive: true,
    seasonStats: {
      playerId: 101, season: 2026, games: 135,
      avg: 0.317, obp: 0.401, slg: 0.551, ops: 0.952, hr: 28, rbi: 95, sb: 3,
      hits: 149, ab: 470, era: null, whip: null, kPer9: null, wins: null, losses: null, ip: null, so: null,
    },
  },
  {
    id: 102, teamId: 1, name: "홍창기", nameEn: "Hong Chang-ki", number: 51,
    position: "CF", throwsBats: "우투좌타", birthDate: "1993-11-19", photoUrl: null, isActive: true,
    seasonStats: {
      playerId: 102, season: 2026, games: 140,
      avg: 0.298, obp: 0.365, slg: 0.423, ops: 0.788, hr: 8, rbi: 52, sb: 25,
      hits: 162, ab: 544, era: null, whip: null, kPer9: null, wins: null, losses: null, ip: null, so: null,
    },
  },
  {
    id: 103, teamId: 1, name: "구본혁", nameEn: "Gu Bon-hyeok", number: 7,
    position: "SS", throwsBats: "우투좌타", birthDate: "2002-03-10", photoUrl: null, isActive: true,
    seasonStats: {
      playerId: 103, season: 2026, games: 138,
      avg: 0.291, obp: 0.352, slg: 0.458, ops: 0.810, hr: 15, rbi: 68, sb: 18,
      hits: 155, ab: 533, era: null, whip: null, kPer9: null, wins: null, losses: null, ip: null, so: null,
    },
  },
  {
    id: 104, teamId: 1, name: "김현수", nameEn: "Kim Hyun-soo", number: 22,
    position: "LF", throwsBats: "우투좌타", birthDate: "1988-01-12", photoUrl: null, isActive: true,
    seasonStats: {
      playerId: 104, season: 2026, games: 125,
      avg: 0.285, obp: 0.389, slg: 0.435, ops: 0.824, hr: 12, rbi: 58, sb: 1,
      hits: 128, ab: 449, era: null, whip: null, kPer9: null, wins: null, losses: null, ip: null, so: null,
    },
  },
  {
    id: 105, teamId: 1, name: "문보경", nameEn: "Moon Bo-gyeong", number: 23,
    position: "1B", throwsBats: "우투좌타", birthDate: "1998-03-15", photoUrl: null, isActive: true,
    seasonStats: {
      playerId: 105, season: 2026, games: 130,
      avg: 0.278, obp: 0.355, slg: 0.489, ops: 0.844, hr: 22, rbi: 78, sb: 2,
      hits: 133, ab: 478, era: null, whip: null, kPer9: null, wins: null, losses: null, ip: null, so: null,
    },
  },
  {
    id: 106, teamId: 1, name: "박해민", nameEn: "Park Hae-min", number: 17,
    position: "RF", throwsBats: "우투좌타", birthDate: "1990-06-30", photoUrl: null, isActive: true,
    seasonStats: {
      playerId: 106, season: 2026, games: 128,
      avg: 0.272, obp: 0.341, slg: 0.385, ops: 0.726, hr: 5, rbi: 38, sb: 30,
      hits: 125, ab: 460, era: null, whip: null, kPer9: null, wins: null, losses: null, ip: null, so: null,
    },
  },
  {
    id: 107, teamId: 1, name: "박동원", nameEn: "Park Dong-won", number: 10,
    position: "C", throwsBats: "우투우타", birthDate: "1990-12-06", photoUrl: null, isActive: true,
    seasonStats: {
      playerId: 107, season: 2026, games: 110,
      avg: 0.261, obp: 0.332, slg: 0.401, ops: 0.733, hr: 10, rbi: 45, sb: 0,
      hits: 98, ab: 375, era: null, whip: null, kPer9: null, wins: null, losses: null, ip: null, so: null,
    },
  },
  {
    id: 108, teamId: 1, name: "신민재", nameEn: "Shin Min-jae", number: 5,
    position: "2B", throwsBats: "우투좌타", birthDate: "2000-08-14", photoUrl: null, isActive: true,
    seasonStats: {
      playerId: 108, season: 2026, games: 132,
      avg: 0.268, obp: 0.325, slg: 0.371, ops: 0.696, hr: 6, rbi: 42, sb: 22,
      hits: 130, ab: 485, era: null, whip: null, kPer9: null, wins: null, losses: null, ip: null, so: null,
    },
  },
  {
    id: 109, teamId: 1, name: "문성주", nameEn: "Moon Seong-ju", number: 25,
    position: "3B", throwsBats: "우투우타", birthDate: "1998-04-03", photoUrl: null, isActive: true,
    seasonStats: {
      playerId: 109, season: 2026, games: 118,
      avg: 0.255, obp: 0.318, slg: 0.398, ops: 0.716, hr: 11, rbi: 50, sb: 8,
      hits: 108, ab: 424, era: null, whip: null, kPer9: null, wins: null, losses: null, ip: null, so: null,
    },
  },
];

/* ===== LG 트윈스 주요 투수 (목업) ===== */
export const LG_PITCHERS: (Player & { seasonStats: PlayerSeasonStats })[] = [
  {
    id: 201, teamId: 1, name: "케이시 켈리", nameEn: "Casey Kelly", number: 29,
    position: "SP", throwsBats: "우투우타", birthDate: "1989-10-04", photoUrl: null, isActive: true,
    seasonStats: {
      playerId: 201, season: 2026, games: 30,
      avg: null, obp: null, slg: null, ops: null, hr: null, rbi: null, sb: null,
      hits: null, ab: null, era: 3.12, whip: 1.15, kPer9: 8.7, wins: 15, losses: 7, ip: 185.2, so: 179,
    },
  },
  {
    id: 202, teamId: 1, name: "엔스", nameEn: "Ens", number: 43,
    position: "SP", throwsBats: "좌투좌타", birthDate: "1991-08-22", photoUrl: null, isActive: true,
    seasonStats: {
      playerId: 202, season: 2026, games: 28,
      avg: null, obp: null, slg: null, ops: null, hr: null, rbi: null, sb: null,
      hits: null, ab: null, era: 3.45, whip: 1.22, kPer9: 7.9, wins: 13, losses: 8, ip: 170.1, so: 149,
    },
  },
  {
    id: 203, teamId: 1, name: "임찬규", nameEn: "Im Chan-gyu", number: 35,
    position: "SP", throwsBats: "좌투좌타", birthDate: "1996-01-07", photoUrl: null, isActive: true,
    seasonStats: {
      playerId: 203, season: 2026, games: 29,
      avg: null, obp: null, slg: null, ops: null, hr: null, rbi: null, sb: null,
      hits: null, ab: null, era: 3.78, whip: 1.28, kPer9: 8.2, wins: 11, losses: 9, ip: 162.0, so: 148,
    },
  },
  {
    id: 204, teamId: 1, name: "고우석", nameEn: "Go Woo-seok", number: 34,
    position: "RP", throwsBats: "우투우타", birthDate: "1998-08-06", photoUrl: null, isActive: true,
    seasonStats: {
      playerId: 204, season: 2026, games: 65,
      avg: null, obp: null, slg: null, ops: null, hr: null, rbi: null, sb: null,
      hits: null, ab: null, era: 2.15, whip: 0.98, kPer9: 10.5, wins: 4, losses: 2, ip: 71.0, so: 83,
    },
  },
  {
    id: 205, teamId: 1, name: "정우영", nameEn: "Jeong Woo-yeong", number: 61,
    position: "RP", throwsBats: "우투우타", birthDate: "1999-09-14", photoUrl: null, isActive: true,
    seasonStats: {
      playerId: 205, season: 2026, games: 58,
      avg: null, obp: null, slg: null, ops: null, hr: null, rbi: null, sb: null,
      hits: null, ab: null, era: 2.85, whip: 1.08, kPer9: 9.3, wins: 5, losses: 3, ip: 63.0, so: 65,
    },
  },
];

export const ALL_LG_PLAYERS = [...LG_BATTERS, ...LG_PITCHERS];

/* ===== 경기별 스탯 (추이 차트용) ===== */
export interface PlayerGameLog {
  date: string;
  avg: number;
  ops: number;
}

export interface PitcherGameLog {
  date: string;
  era: number;
  whip: number;
}

// 오스틴 최근 10경기 타율/OPS 변화
export const AUSTIN_GAME_LOG: PlayerGameLog[] = [
  { date: "9/1", avg: 0.308, ops: 0.931 },
  { date: "9/3", avg: 0.310, ops: 0.938 },
  { date: "9/5", avg: 0.305, ops: 0.925 },
  { date: "9/7", avg: 0.312, ops: 0.942 },
  { date: "9/9", avg: 0.315, ops: 0.948 },
  { date: "9/11", avg: 0.318, ops: 0.955 },
  { date: "9/13", avg: 0.314, ops: 0.945 },
  { date: "9/15", avg: 0.320, ops: 0.960 },
  { date: "9/17", avg: 0.316, ops: 0.950 },
  { date: "9/19", avg: 0.317, ops: 0.952 },
];

// 홍창기 최근 10경기
export const HONG_GAME_LOG: PlayerGameLog[] = [
  { date: "9/1", avg: 0.291, ops: 0.775 },
  { date: "9/3", avg: 0.293, ops: 0.780 },
  { date: "9/5", avg: 0.290, ops: 0.772 },
  { date: "9/7", avg: 0.295, ops: 0.785 },
  { date: "9/9", avg: 0.297, ops: 0.790 },
  { date: "9/11", avg: 0.296, ops: 0.788 },
  { date: "9/13", avg: 0.299, ops: 0.792 },
  { date: "9/15", avg: 0.297, ops: 0.787 },
  { date: "9/17", avg: 0.300, ops: 0.795 },
  { date: "9/19", avg: 0.298, ops: 0.788 },
];

// 케이시 켈리 최근 10경기 ERA/WHIP
export const KELLY_GAME_LOG: PitcherGameLog[] = [
  { date: "9/1", era: 3.25, whip: 1.18 },
  { date: "9/5", era: 3.18, whip: 1.16 },
  { date: "9/10", era: 3.30, whip: 1.20 },
  { date: "9/15", era: 3.15, whip: 1.14 },
  { date: "9/20", era: 3.08, whip: 1.12 },
  { date: "9/25", era: 3.22, whip: 1.17 },
  { date: "9/30", era: 3.10, whip: 1.13 },
  { date: "10/3", era: 3.05, whip: 1.11 },
  { date: "10/7", era: 3.15, whip: 1.16 },
  { date: "10/10", era: 3.12, whip: 1.15 },
];

// 고우석 최근 10경기 ERA/WHIP
export const GO_GAME_LOG: PitcherGameLog[] = [
  { date: "9/1", era: 2.30, whip: 1.02 },
  { date: "9/3", era: 2.25, whip: 1.00 },
  { date: "9/5", era: 2.18, whip: 0.97 },
  { date: "9/8", era: 2.35, whip: 1.05 },
  { date: "9/10", era: 2.20, whip: 0.99 },
  { date: "9/13", era: 2.10, whip: 0.96 },
  { date: "9/16", era: 2.22, whip: 1.00 },
  { date: "9/19", era: 2.18, whip: 0.98 },
  { date: "9/22", era: 2.12, whip: 0.97 },
  { date: "9/25", era: 2.15, whip: 0.98 },
];

/** 선수 ID로 게임 로그 조회 */
export function getPlayerGameLog(playerId: number): PlayerGameLog[] | PitcherGameLog[] | null {
  const map: Record<number, PlayerGameLog[] | PitcherGameLog[]> = {
    101: AUSTIN_GAME_LOG,
    102: HONG_GAME_LOG,
    201: KELLY_GAME_LOG,
    204: GO_GAME_LOG,
  };
  return map[playerId] ?? null;
}

/** 선수 ID로 선수 정보 조회 */
export function getPlayerById(playerId: number) {
  return ALL_LG_PLAYERS.find((p) => p.id === playerId) ?? null;
}

/* ===== 리그 평균 (백분위 계산용) ===== */
export const LEAGUE_AVG_BATTER = {
  avg: 0.267,
  ops: 0.735,
  hr: 16,
  rbi: 58,
  sb: 10,
};

export const LEAGUE_AVG_PITCHER = {
  era: 4.25,
  whip: 1.35,
  kPer9: 7.5,
  wins: 9,
  ip: 140,
};

/* ===== 포지션 그룹 ===== */
export type PositionGroup = "투수" | "포수" | "내야수" | "외야수";

export function getPositionGroup(position: string): PositionGroup {
  if (["SP", "RP", "CP"].includes(position)) return "투수";
  if (position === "C") return "포수";
  if (["1B", "2B", "3B", "SS"].includes(position)) return "내야수";
  return "외야수";
}

export const POSITION_LABELS: Record<string, string> = {
  SP: "선발",
  RP: "중계",
  CP: "마무리",
  C: "포수",
  "1B": "1루수",
  "2B": "2루수",
  "3B": "3루수",
  SS: "유격수",
  LF: "좌익수",
  CF: "중견수",
  RF: "우익수",
  DH: "지명타자",
};

/* ===== 시즌 하이라이트 목업 ===== */
export interface SeasonHighlight {
  label: string;
  value: string;
  date: string;
}

export function getSeasonHighlights(playerId: number): SeasonHighlight[] {
  const map: Record<number, SeasonHighlight[]> = {
    101: [
      { label: "시즌 최다 홈런", value: "3홈런", date: "7월 15일 vs 두산" },
      { label: "시즌 최다 타점", value: "6타점", date: "8월 3일 vs KT" },
      { label: "연속 안타", value: "12경기", date: "6월 10일~25일" },
    ],
    201: [
      { label: "시즌 최다 탈삼진", value: "12K", date: "6월 20일 vs SSG" },
      { label: "완봉승", value: "9이닝 0실점", date: "7월 8일 vs 삼성" },
    ],
    204: [
      { label: "연속 세이브", value: "15경기", date: "5월~6월" },
      { label: "시즌 최고 탈삼진", value: "측면 4K", date: "8월 12일 vs NC" },
    ],
  };
  return map[playerId] ?? [];
}
