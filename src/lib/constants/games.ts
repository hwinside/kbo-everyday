import type { Game, GameState, GamePlay, GameInning } from "@/lib/types";

/* ===== 오늘의 경기 5개 ===== */
export const MOCK_GAMES: Game[] = [
  {
    id: "20260328-LG-DS",
    date: "2026-03-28",
    time: "18:30",
    homeTeamId: 2,    // 두산
    awayTeamId: 1,    // LG
    status: "live",
    inning: "5회말",
    homeScore: 20,
    awayScore: 3,
    stadium: "잠실",
    updatedAt: "2026-03-28T19:45:00Z",
  },
  {
    id: "20260328-SSG-HW",
    date: "2026-03-28",
    time: "18:30",
    homeTeamId: 4,    // SSG
    awayTeamId: 9,    // 한화
    status: "scheduled",
    inning: null,
    homeScore: 0,
    awayScore: 0,
    stadium: "인천",
    updatedAt: "2026-03-28T10:00:00Z",
  },
  {
    id: "20260328-KT-NC",
    date: "2026-03-28",
    time: "18:30",
    homeTeamId: 3,    // KT
    awayTeamId: 5,    // NC
    status: "scheduled",
    inning: null,
    homeScore: 0,
    awayScore: 0,
    stadium: "수원",
    updatedAt: "2026-03-28T10:00:00Z",
  },
  {
    id: "20260328-KIA-LT",
    date: "2026-03-28",
    time: "14:00",
    homeTeamId: 6,    // KIA
    awayTeamId: 7,    // 롯데
    status: "final",
    inning: "종료",
    homeScore: 7,
    awayScore: 3,
    stadium: "광주",
    updatedAt: "2026-03-28T17:20:00Z",
  },
  {
    id: "20260328-SS-KW",
    date: "2026-03-28",
    time: "18:30",
    homeTeamId: 8,    // 삼성
    awayTeamId: 10,   // 키움
    status: "scheduled",
    inning: null,
    homeScore: 0,
    awayScore: 0,
    stadium: "대구",
    updatedAt: "2026-03-28T10:00:00Z",
  },
];

/* ===== LG vs 두산 이닝별 점수 ===== */
export const MOCK_INNINGS: GameInning[] = [
  { gameId: "20260328-LG-DS", inning: 1, topScore: 0, bottomScore: 0 },
  { gameId: "20260328-LG-DS", inning: 2, topScore: 1, bottomScore: 0 },
  { gameId: "20260328-LG-DS", inning: 3, topScore: 0, bottomScore: 1 },
  { gameId: "20260328-LG-DS", inning: 4, topScore: 0, bottomScore: 1 },
  { gameId: "20260328-LG-DS", inning: 5, topScore: 2, bottomScore: null },
  // 6~9회는 아직 진행 안 됨
  // KIA vs 롯데 (종료)
  { gameId: "20260328-KIA-LT", inning: 1, topScore: 0, bottomScore: 2 },
  { gameId: "20260328-KIA-LT", inning: 2, topScore: 1, bottomScore: 0 },
  { gameId: "20260328-KIA-LT", inning: 3, topScore: 0, bottomScore: 3 },
  { gameId: "20260328-KIA-LT", inning: 4, topScore: 0, bottomScore: 0 },
  { gameId: "20260328-KIA-LT", inning: 5, topScore: 1, bottomScore: 0 },
  { gameId: "20260328-KIA-LT", inning: 6, topScore: 0, bottomScore: 1 },
  { gameId: "20260328-KIA-LT", inning: 7, topScore: 0, bottomScore: 0 },
  { gameId: "20260328-KIA-LT", inning: 8, topScore: 1, bottomScore: 1 },
  { gameId: "20260328-KIA-LT", inning: 9, topScore: 0, bottomScore: 0 },
];

/* ===== LG vs 두산 현재 게임 상태 ===== */
export const MOCK_GAME_STATE: GameState = {
  gameId: "20260328-LG-DS",
  balls: 2,
  strikes: 1,
  outs: 1,
  runner1b: false,
  runner2b: true,
  runner3b: false,
  currentBatter: "오스틴",
  currentPitcher: "곽빈",
};

/* ===== LG vs 두산 문자 중계 ===== */
export const MOCK_PLAYS: GamePlay[] = [
  // 1회초
  { id: 1, gameId: "20260328-LG-DS", inning: "1회초", sequence: 1, description: "홍창기 중전안타", isHighlight: false, batter: "홍창기", pitcher: "곽빈", createdAt: "2026-03-28T18:35:00Z" },
  { id: 2, gameId: "20260328-LG-DS", inning: "1회초", sequence: 2, description: "구본혁 번트 실패 삼진", isHighlight: false, batter: "구본혁", pitcher: "곽빈", createdAt: "2026-03-28T18:37:00Z" },
  { id: 3, gameId: "20260328-LG-DS", inning: "1회초", sequence: 3, description: "오스틴 우비 플라이", isHighlight: false, batter: "오스틴", pitcher: "곽빈", createdAt: "2026-03-28T18:39:00Z" },
  { id: 4, gameId: "20260328-LG-DS", inning: "1회초", sequence: 4, description: "김현수 유격수 땅볼 아웃", isHighlight: false, batter: "김현수", pitcher: "곽빈", createdAt: "2026-03-28T18:41:00Z" },
  // 1회말
  { id: 5, gameId: "20260328-LG-DS", inning: "1회말", sequence: 1, description: "정수빈 볼넷", isHighlight: false, batter: "정수빈", pitcher: "케이시 켈리", createdAt: "2026-03-28T18:45:00Z" },
  { id: 6, gameId: "20260328-LG-DS", inning: "1회말", sequence: 2, description: "양석환 유격수 땅볼 병살", isHighlight: false, batter: "양석환", pitcher: "케이시 켈리", createdAt: "2026-03-28T18:48:00Z" },
  { id: 7, gameId: "20260328-LG-DS", inning: "1회말", sequence: 3, description: "페르난데스 삼진", isHighlight: false, batter: "페르난데스", pitcher: "케이시 켈리", createdAt: "2026-03-28T18:50:00Z" },
  // 2회초
  { id: 8, gameId: "20260328-LG-DS", inning: "2회초", sequence: 1, description: "문보경 좌전안타", isHighlight: false, batter: "문보경", pitcher: "곽빈", createdAt: "2026-03-28T18:55:00Z" },
  { id: 9, gameId: "20260328-LG-DS", inning: "2회초", sequence: 2, description: "박해민 볼넷 (1·2루)", isHighlight: false, batter: "박해민", pitcher: "곽빈", createdAt: "2026-03-28T18:57:00Z" },
  { id: 10, gameId: "20260328-LG-DS", inning: "2회초", sequence: 3, description: "⚾ 박동원 좌전 적시타 (1타점) — LG 1:0", isHighlight: true, batter: "박동원", pitcher: "곽빈", createdAt: "2026-03-28T18:59:00Z" },
  { id: 11, gameId: "20260328-LG-DS", inning: "2회초", sequence: 4, description: "신민재 삼진", isHighlight: false, batter: "신민재", pitcher: "곽빈", createdAt: "2026-03-28T19:01:00Z" },
  { id: 12, gameId: "20260328-LG-DS", inning: "2회초", sequence: 5, description: "문성주 우비 플라이", isHighlight: false, batter: "문성주", pitcher: "곽빈", createdAt: "2026-03-28T19:03:00Z" },
  // 3회초
  { id: 13, gameId: "20260328-LG-DS", inning: "3회초", sequence: 1, description: "홍창기 삼진", isHighlight: false, batter: "홍창기", pitcher: "곽빈", createdAt: "2026-03-28T19:10:00Z" },
  // 3회말
  { id: 14, gameId: "20260328-LG-DS", inning: "3회말", sequence: 1, description: "김재환 2루타", isHighlight: false, batter: "김재환", pitcher: "케이시 켈리", createdAt: "2026-03-28T19:15:00Z" },
  { id: 15, gameId: "20260328-LG-DS", inning: "3회말", sequence: 2, description: "⚾ 허경민 좌전 적시타 (1타점) — 1:1 동점", isHighlight: true, batter: "허경민", pitcher: "케이시 켈리", createdAt: "2026-03-28T19:17:00Z" },
  // 4회말
  { id: 16, gameId: "20260328-LG-DS", inning: "4회말", sequence: 1, description: "정수빈 중전안타", isHighlight: false, batter: "정수빈", pitcher: "케이시 켈리", createdAt: "2026-03-28T19:25:00Z" },
  { id: 17, gameId: "20260328-LG-DS", inning: "4회말", sequence: 2, description: "정수빈 도루 성공 (2루)", isHighlight: false, batter: "정수빈", pitcher: "케이시 켈리", createdAt: "2026-03-28T19:27:00Z" },
  { id: 18, gameId: "20260328-LG-DS", inning: "4회말", sequence: 3, description: "⚾ 양석환 중전 적시타 (1타점) — 두산 2:1 역전", isHighlight: true, batter: "양석환", pitcher: "케이시 켈리", createdAt: "2026-03-28T19:29:00Z" },
  // 5회초
  { id: 19, gameId: "20260328-LG-DS", inning: "5회초", sequence: 1, description: "구본혁 좌전안타", isHighlight: false, batter: "구본혁", pitcher: "곽빈", createdAt: "2026-03-28T19:35:00Z" },
  { id: 20, gameId: "20260328-LG-DS", inning: "5회초", sequence: 2, description: "⚾ 오스틴 좌중간 2점 홈런!!! — LG 3:2 재역전", isHighlight: true, batter: "오스틴", pitcher: "곽빈", createdAt: "2026-03-28T19:37:00Z" },
  // 5회말 (진행중)
  { id: 21, gameId: "20260328-LG-DS", inning: "5회말", sequence: 1, description: "김재환 볼넷", isHighlight: false, batter: "김재환", pitcher: "케이시 켈리", createdAt: "2026-03-28T19:42:00Z" },
  { id: 22, gameId: "20260328-LG-DS", inning: "5회말", sequence: 2, description: "허경민 번트 희생타 (주자 2루)", isHighlight: false, batter: "허경민", pitcher: "케이시 켈리", createdAt: "2026-03-28T19:44:00Z" },
];

/* ===== 채팅 메시지 ===== */
export interface ChatMessage {
  id: number;
  teamId: number;
  nickname: string;
  level: number;
  content: string;
  createdAt: string;
}

export const MOCK_CHAT_MESSAGES: ChatMessage[] = [
  { id: 1, teamId: 1, nickname: "엘지골드", level: 15, content: "오늘 케이시 켈리 컨디션 좋아보인다", createdAt: "2026-03-28T18:31:00Z" },
  { id: 2, teamId: 2, nickname: "곰팬", level: 8, content: "곽빈 파이팅!!! 잠실 분위기 좋음", createdAt: "2026-03-28T18:32:00Z" },
  { id: 3, teamId: 1, nickname: "야구조아", level: 5, content: "홍창기 오늘 멀티히트 가자", createdAt: "2026-03-28T18:35:30Z" },
  { id: 4, teamId: 2, nickname: "베어스매니아", level: 12, content: "잠실 매진이야?? 대박", createdAt: "2026-03-28T18:36:00Z" },
  { id: 5, teamId: 1, nickname: "트윈스매니아", level: 20, content: "홍창기 안타! 시작이 좋다", createdAt: "2026-03-28T18:35:30Z" },
  { id: 6, teamId: 2, nickname: "곰팬", level: 8, content: "괜찮아 곽빈 잘 던지고 있어", createdAt: "2026-03-28T18:40:00Z" },
  { id: 7, teamId: 1, nickname: "LG전사", level: 3, content: "오스틴 아쉽다 ㅠㅠ", createdAt: "2026-03-28T18:39:30Z" },
  { id: 8, teamId: 2, nickname: "두산마스터", level: 22, content: "양석환 병살 ㅋㅋ 고마워", createdAt: "2026-03-28T18:48:30Z" },
  { id: 9, teamId: 1, nickname: "엘지골드", level: 15, content: "문보경 안타! 찬스다", createdAt: "2026-03-28T18:55:30Z" },
  { id: 10, teamId: 1, nickname: "야구조아", level: 5, content: "박동원 적시타!!! 1:0!!! 가자!!!", createdAt: "2026-03-28T18:59:30Z" },
  { id: 11, teamId: 2, nickname: "베어스매니아", level: 12, content: "아 곽빈 집중해라", createdAt: "2026-03-28T19:00:00Z" },
  { id: 12, teamId: 1, nickname: "트윈스매니아", level: 20, content: "🔥🔥🔥 선취점!!!", createdAt: "2026-03-28T19:00:30Z" },
  { id: 13, teamId: 2, nickname: "두산마스터", level: 22, content: "김재환 2루타! 반격 시작", createdAt: "2026-03-28T19:15:30Z" },
  { id: 14, teamId: 2, nickname: "곰팬", level: 8, content: "허경민 적시타 동점!!! ㅋㅋㅋ", createdAt: "2026-03-28T19:17:30Z" },
  { id: 15, teamId: 1, nickname: "LG전사", level: 3, content: "켈리야 집중해ㅠㅠ", createdAt: "2026-03-28T19:18:00Z" },
  { id: 16, teamId: 2, nickname: "베어스매니아", level: 12, content: "양석환 역전 적시타!! 두산 화이팅!!", createdAt: "2026-03-28T19:29:30Z" },
  { id: 17, teamId: 1, nickname: "엘지골드", level: 15, content: "아 역전당했네... 켈리 왜이래", createdAt: "2026-03-28T19:30:00Z" },
  { id: 18, teamId: 1, nickname: "트윈스매니아", level: 20, content: "🚀🚀🚀 오스틴 홈런!!! 재역전!!! 미쳤다!!!", createdAt: "2026-03-28T19:37:30Z" },
  { id: 19, teamId: 2, nickname: "곰팬", level: 8, content: "아 곽빈 홈런 맞았어... ㅠ", createdAt: "2026-03-28T19:38:00Z" },
  { id: 20, teamId: 1, nickname: "야구조아", level: 5, content: "오스틴 사랑해 ❤️❤️ 2점 홈런!!!", createdAt: "2026-03-28T19:38:30Z" },
];

/* ===== 라인업 ===== */
export interface LineupPlayer {
  order: number;
  name: string;
  position: string;
  avg: string;
}

export interface GameLineup {
  gameId: string;
  away: {
    teamId: number;
    startingPitcher: { name: string; era: string };
    batters: LineupPlayer[];
  };
  home: {
    teamId: number;
    startingPitcher: { name: string; era: string };
    batters: LineupPlayer[];
  };
}

export const MOCK_LINEUP: GameLineup = {
  gameId: "20260328-LG-DS",
  away: {
    teamId: 1, // LG
    startingPitcher: { name: "케이시 켈리", era: "2.85" },
    batters: [
      { order: 1, name: "홍창기", position: "CF", avg: ".312" },
      { order: 2, name: "구본혁", position: "SS", avg: ".289" },
      { order: 3, name: "오스틴", position: "DH", avg: ".317" },
      { order: 4, name: "김현수", position: "LF", avg: ".298" },
      { order: 5, name: "문보경", position: "3B", avg: ".275" },
      { order: 6, name: "박해민", position: "RF", avg: ".265" },
      { order: 7, name: "박동원", position: "C", avg: ".255" },
      { order: 8, name: "신민재", position: "2B", avg: ".248" },
      { order: 9, name: "문성주", position: "1B", avg: ".260" },
    ],
  },
  home: {
    teamId: 2, // 두산
    startingPitcher: { name: "곽빈", era: "3.42" },
    batters: [
      { order: 1, name: "정수빈", position: "CF", avg: ".305" },
      { order: 2, name: "양석환", position: "1B", avg: ".292" },
      { order: 3, name: "페르난데스", position: "DH", avg: ".310" },
      { order: 4, name: "김재환", position: "LF", avg: ".285" },
      { order: 5, name: "허경민", position: "2B", avg: ".278" },
      { order: 6, name: "강승호", position: "3B", avg: ".252" },
      { order: 7, name: "조수행", position: "SS", avg: ".240" },
      { order: 8, name: "박세혁", position: "RF", avg: ".235" },
      { order: 9, name: "장승현", position: "C", avg: ".220" },
    ],
  },
};

/* ===== Helpers ===== */
export function getGameById(id: string): Game | undefined {
  return MOCK_GAMES.find((g) => g.id === id);
}

export function getInningsForGame(gameId: string): GameInning[] {
  return MOCK_INNINGS.filter((i) => i.gameId === gameId);
}

export function getPlaysForGame(gameId: string): GamePlay[] {
  return MOCK_PLAYS.filter((p) => p.gameId === gameId);
}
