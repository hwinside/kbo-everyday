import type { MOCK_GAMES } from "./games";

/* ===== 승부예측 목업 데이터 ===== */

export interface PredictionMock {
  gameId: string;
  homeTeamId: number;
  awayTeamId: number;
  time: string;
  stadium: string;
  homePercent: number;
  awayPercent: number;
  totalVotes: number;
  /** 현재 유저의 예측 (null = 미예측) */
  myPick: number | null;
  /** 경기 상태 */
  status: "open" | "locked" | "finished";
  /** 종료 경기: 승리팀 ID */
  winnerTeamId: number | null;
  /** 종료 경기: 홈 점수 */
  homeScore: number | null;
  /** 종료 경기: 원정 점수 */
  awayScore: number | null;
}

export const MOCK_PREDICTIONS: PredictionMock[] = [
  {
    gameId: "20260328-LG-DS",
    homeTeamId: 2,
    awayTeamId: 1,
    time: "18:30",
    stadium: "잠실",
    homePercent: 37,
    awayPercent: 63,
    totalVotes: 1234,
    myPick: 1, // LG에 배팅
    status: "locked",
    winnerTeamId: null,
    homeScore: 2,
    awayScore: 3,
  },
  {
    gameId: "20260328-SSG-HW",
    homeTeamId: 4,
    awayTeamId: 9,
    time: "18:30",
    stadium: "인천",
    homePercent: 55,
    awayPercent: 45,
    totalVotes: 892,
    myPick: 4, // SSG에 배팅
    status: "open",
    winnerTeamId: null,
    homeScore: null,
    awayScore: null,
  },
  {
    gameId: "20260328-KT-NC",
    homeTeamId: 3,
    awayTeamId: 5,
    time: "18:30",
    stadium: "수원",
    homePercent: 48,
    awayPercent: 52,
    totalVotes: 567,
    myPick: null, // 미예측
    status: "open",
    winnerTeamId: null,
    homeScore: null,
    awayScore: null,
  },
  {
    gameId: "20260328-KIA-LT",
    homeTeamId: 6,
    awayTeamId: 7,
    time: "14:00",
    stadium: "광주",
    homePercent: 72,
    awayPercent: 28,
    totalVotes: 1567,
    myPick: 6, // KIA에 배팅 → 적중!
    status: "finished",
    winnerTeamId: 6,
    homeScore: 7,
    awayScore: 3,
  },
  {
    gameId: "20260328-SS-KW",
    homeTeamId: 8,
    awayTeamId: 10,
    time: "18:30",
    stadium: "대구",
    homePercent: 42,
    awayPercent: 58,
    totalVotes: 345,
    myPick: 10, // 키움에 배팅
    status: "open",
    winnerTeamId: null,
    homeScore: null,
    awayScore: null,
  },
];

/* ===== 내 예측 결과 통계 ===== */
export const MY_PREDICTION_STATS = {
  currentStreak: 3,
  maxStreak: 7,
  totalPredictions: 42,
  totalCorrect: 27,
  points: 892,
  todayPoints: 25,
};

/* ===== 리더보드 목업 ===== */
export interface LeaderboardEntry {
  rank: number;
  userId: string;
  nickname: string;
  teamId: number;
  level: number;
  points: number;
  totalPredictions: number;
  totalCorrect: number;
  currentStreak: number;
  isMe?: boolean;
}

export const MOCK_LEADERBOARD: LeaderboardEntry[] = [
  { rank: 1, userId: "u1", nickname: "야구마스터", teamId: 1, level: 30, points: 5230, totalPredictions: 150, totalCorrect: 112, currentStreak: 12 },
  { rank: 2, userId: "u2", nickname: "크보덕후", teamId: 6, level: 27, points: 4891, totalPredictions: 148, totalCorrect: 105, currentStreak: 5 },
  { rank: 3, userId: "u3", nickname: "엘지골드", teamId: 1, level: 24, points: 3456, totalPredictions: 140, totalCorrect: 98, currentStreak: 2 },
  { rank: 4, userId: "u4", nickname: "타이거팬", teamId: 6, level: 22, points: 3120, totalPredictions: 135, totalCorrect: 91, currentStreak: 0 },
  { rank: 5, userId: "u5", nickname: "베어스킹", teamId: 2, level: 20, points: 2890, totalPredictions: 130, totalCorrect: 87, currentStreak: 4 },
  { rank: 6, userId: "u6", nickname: "위즈돔", teamId: 3, level: 19, points: 2650, totalPredictions: 128, totalCorrect: 84, currentStreak: 1 },
  { rank: 7, userId: "u7", nickname: "랜더스팬", teamId: 4, level: 18, points: 2400, totalPredictions: 125, totalCorrect: 80, currentStreak: 3 },
  { rank: 8, userId: "u8", nickname: "다이노스", teamId: 5, level: 17, points: 2180, totalPredictions: 120, totalCorrect: 76, currentStreak: 0 },
  { rank: 9, userId: "u9", nickname: "자이언츠매니아", teamId: 7, level: 16, points: 1950, totalPredictions: 118, totalCorrect: 73, currentStreak: 6 },
  { rank: 10, userId: "u10", nickname: "라이온킹", teamId: 8, level: 15, points: 1780, totalPredictions: 115, totalCorrect: 70, currentStreak: 1 },
  { rank: 11, userId: "u11", nickname: "이글스전사", teamId: 9, level: 14, points: 1620, totalPredictions: 110, totalCorrect: 67, currentStreak: 2 },
  { rank: 12, userId: "u12", nickname: "히어로즈팬", teamId: 10, level: 13, points: 1480, totalPredictions: 108, totalCorrect: 64, currentStreak: 0 },
  { rank: 13, userId: "u13", nickname: "직관러", teamId: 1, level: 12, points: 1350, totalPredictions: 105, totalCorrect: 61, currentStreak: 3 },
  { rank: 14, userId: "u14", nickname: "야구의신", teamId: 2, level: 11, points: 1220, totalPredictions: 100, totalCorrect: 58, currentStreak: 1 },
  { rank: 15, userId: "u15", nickname: "홈런왕", teamId: 6, level: 10, points: 1100, totalPredictions: 98, totalCorrect: 55, currentStreak: 0 },
  { rank: 16, userId: "u16", nickname: "삼진마스터", teamId: 3, level: 9, points: 980, totalPredictions: 95, totalCorrect: 52, currentStreak: 2 },
  { rank: 17, userId: "u17", nickname: "응원단장", teamId: 4, level: 8, points: 920, totalPredictions: 92, totalCorrect: 49, currentStreak: 0 },
  { rank: 18, userId: "me", nickname: "나", teamId: 1, level: 8, points: 892, totalPredictions: 42, totalCorrect: 27, currentStreak: 3, isMe: true },
  { rank: 19, userId: "u19", nickname: "글러브마스터", teamId: 5, level: 7, points: 850, totalPredictions: 88, totalCorrect: 46, currentStreak: 1 },
  { rank: 20, userId: "u20", nickname: "야구초보", teamId: 9, level: 5, points: 680, totalPredictions: 80, totalCorrect: 40, currentStreak: 0 },
];
