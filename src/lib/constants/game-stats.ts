/* ===== 경기 스탯 목업 데이터 ===== */

export interface BatterStat {
  order: number;
  name: string;
  position: string; // 포지션
  ab: number;       // 타수
  r: number;        // 득점
  h: number;        // 안타
  rbi: number;      // 타점
  hr: number;       // 홈런
  bb: number;       // 볼넷
  so: number;       // 삼진
  sb: number;       // 도루
  avg: string;      // 타율
  isSubstitute?: boolean; // 교체 선수
}

export interface PitcherStat {
  name: string;
  result?: "win" | "loss" | "save" | "hold"; // 승/패/세/홀
  ip: string;       // 이닝
  h: number;        // 피안타
  r: number;        // 실점
  er: number;       // 자책
  bb: number;       // 4사구
  so: number;       // 삼진
  hr: number;       // 피홈런
  bf: number;       // 타자
  ab: number;       // 타수
  np: number;       // 투구수
  g: number;        // 경기
  w: number;        // 승리
  l: number;        // 패전
  sv: number;       // 세이브
  hd: number;       // 홀드
  era: string;      // 평균자책
}

export interface GameStats {
  gameId: string;
  away: {
    teamId: number;
    batters: BatterStat[];
    pitchers: PitcherStat[];
  };
  home: {
    teamId: number;
    batters: BatterStat[];
    pitchers: PitcherStat[];
  };
}

export const MOCK_GAME_STATS: GameStats = {
  gameId: "20260328-LG-DS",
  away: {
    teamId: 1, // LG
    batters: [
      { order: 1, name: "홍창기", position: "중", ab: 4, r: 1, h: 2, rbi: 0, hr: 0, bb: 1, so: 0, sb: 1, avg: ".321" },
      { order: 2, name: "구본혁", position: "유", ab: 4, r: 1, h: 1, rbi: 0, hr: 0, bb: 0, so: 1, sb: 0, avg: ".287" },
      { order: 3, name: "오스틴", position: "지", ab: 3, r: 1, h: 2, rbi: 3, hr: 1, bb: 1, so: 0, sb: 0, avg: ".345" },
      { order: 4, name: "김현수", position: "좌", ab: 4, r: 0, h: 0, rbi: 0, hr: 0, bb: 0, so: 2, sb: 0, avg: ".256" },
      { order: 5, name: "문보경", position: "삼", ab: 3, r: 1, h: 1, rbi: 1, hr: 0, bb: 1, so: 0, sb: 0, avg: ".312" },
      { order: 6, name: "박해민", position: "우", ab: 4, r: 0, h: 1, rbi: 0, hr: 0, bb: 0, so: 1, sb: 1, avg: ".278" },
      { order: 7, name: "박동원", position: "포", ab: 3, r: 1, h: 1, rbi: 1, hr: 0, bb: 1, so: 0, sb: 0, avg: ".298" },
      { order: 8, name: "신민재", position: "이", ab: 4, r: 0, h: 1, rbi: 0, hr: 0, bb: 0, so: 1, sb: 0, avg: ".245" },
      { order: 9, name: "문성주", position: "일", ab: 3, r: 0, h: 0, rbi: 0, hr: 0, bb: 1, so: 2, sb: 0, avg: ".198" },
    ],
    pitchers: [
      { name: "케이시 켈리", result: "win", ip: "6.0", h: 4, r: 2, er: 2, bb: 2, so: 7, hr: 1, bf: 24, ab: 22, np: 95, g: 1, w: 1, l: 0, sv: 0, hd: 0, era: "3.00" },
      { name: "고우석",      result: undefined, ip: "2.0", h: 1, r: 0, er: 0, bb: 0, so: 3, hr: 0, bf: 7,  ab: 7,  np: 28, g: 1, w: 0, l: 0, sv: 0, hd: 0, era: "0.00" },
      { name: "정우영",      result: "save",   ip: "1.0", h: 0, r: 0, er: 0, bb: 1, so: 2, hr: 0, bf: 4,  ab: 3,  np: 18, g: 1, w: 0, l: 0, sv: 1, hd: 0, era: "0.00" },
    ],
  },
  home: {
    teamId: 2, // 두산
    batters: [
      { order: 1, name: "정수빈", position: "중", ab: 4, r: 0, h: 1, rbi: 0, hr: 0, bb: 0, so: 1, sb: 1, avg: ".267" },
      { order: 2, name: "양석환", position: "일", ab: 4, r: 1, h: 2, rbi: 1, hr: 0, bb: 0, so: 0, sb: 0, avg: ".315" },
      { order: 3, name: "페르난데스", position: "지", ab: 3, r: 0, h: 0, rbi: 0, hr: 0, bb: 1, so: 2, sb: 0, avg: ".278" },
      { order: 4, name: "김재환", position: "좌", ab: 4, r: 1, h: 1, rbi: 1, hr: 1, bb: 0, so: 1, sb: 0, avg: ".289" },
      { order: 5, name: "허경민", position: "삼", ab: 3, r: 0, h: 1, rbi: 0, hr: 0, bb: 1, so: 0, sb: 0, avg: ".301" },
      { order: 6, name: "강승호", position: "유", ab: 4, r: 0, h: 0, rbi: 0, hr: 0, bb: 0, so: 2, sb: 0, avg: ".234" },
      { order: 7, name: "조수행", position: "이", ab: 3, r: 0, h: 1, rbi: 0, hr: 0, bb: 0, so: 1, sb: 0, avg: ".256" },
      { order: 8, name: "박세혁", position: "우", ab: 3, r: 0, h: 0, rbi: 0, hr: 0, bb: 0, so: 2, sb: 0, avg: ".212" },
      { order: 9, name: "장승현", position: "포", ab: 3, r: 0, h: 0, rbi: 0, hr: 0, bb: 0, so: 3, sb: 0, avg: ".189" },
    ],
    pitchers: [
      { name: "곽빈",   result: "loss",    ip: "5.0", h: 7, r: 4, er: 4, bb: 3, so: 4, hr: 1, bf: 23, ab: 20, np: 89, g: 1, w: 0, l: 1, sv: 0, hd: 0, era: "7.20" },
      { name: "이영하", result: undefined, ip: "2.0", h: 1, r: 1, er: 1, bb: 1, so: 2, hr: 0, bf: 8,  ab: 7,  np: 35, g: 1, w: 0, l: 0, sv: 0, hd: 0, era: "4.50" },
      { name: "홍건희", result: undefined, ip: "2.0", h: 1, r: 0, er: 0, bb: 1, so: 2, hr: 0, bf: 8,  ab: 5,  np: 32, g: 1, w: 0, l: 0, sv: 0, hd: 0, era: "0.00" },
    ],
  },
};

export function getStatsForGame(gameId: string): GameStats | null {
  return MOCK_GAME_STATS.gameId === gameId ? MOCK_GAME_STATS : null;
}
