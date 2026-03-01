/* ===== 니치 데이터: 세이버메트릭스 + 구종별 + 상황별 스탯 ===== */

export interface BatterAdvanced {
  playerId: string;
  // 세이버메트릭스
  wRC: number;       // Weighted Runs Created+
  OPS: number;       // On-base Plus Slugging
  wOBA: number;      // Weighted On-Base Average
  ISO: number;       // Isolated Power
  BABIP: number;     // Batting Avg on Balls In Play
  BB_pct: number;    // 볼넷%
  K_pct: number;     // 삼진%
  WAR: number;       // Wins Above Replacement
  // 구종별 타율
  pitchStats: { type: string; avg: number; ops: number; swing_pct: number; whiff_pct: number }[];
  // 상황별 스탯
  situational: { label: string; avg: number; pa: number; hr: number; rbi: number }[];
  // 핫존 (3x3 grid, -1~1 scale)
  hotZone: number[][];
}

export interface PitcherAdvanced {
  playerId: string;
  FIP: number;       // Fielding Independent Pitching
  xFIP: number;      // Expected FIP
  WHIP: number;
  K9: number;        // K per 9 innings
  BB9: number;       // BB per 9 innings
  HR9: number;       // HR per 9 innings
  WAR: number;
  LOB_pct: number;   // Left On Base %
  GB_pct: number;    // Ground Ball %
  // 구종별 데이터
  pitchMix: { type: string; pct: number; velo: number; spin: number; whiff_pct: number }[];
  // 상황별
  situational: { label: string; avg: number; pa: number; k: number; bb: number }[];
}

export const BATTER_ADVANCED: Record<string, BatterAdvanced> = {
  p1: { // 오스틴 (LG)
    playerId: "p1", wRC: 158, OPS: 0.943, wOBA: 0.408, ISO: 0.267, BABIP: 0.312, BB_pct: 12.4, K_pct: 18.7, WAR: 5.8,
    pitchStats: [
      { type: "직구", avg: 0.312, ops: 0.987, swing_pct: 72.1, whiff_pct: 14.2 },
      { type: "슬라이더", avg: 0.289, ops: 0.876, swing_pct: 55.4, whiff_pct: 28.7 },
      { type: "체인지업", avg: 0.245, ops: 0.712, swing_pct: 48.2, whiff_pct: 32.1 },
      { type: "커브", avg: 0.267, ops: 0.801, swing_pct: 41.8, whiff_pct: 22.5 },
      { type: "커터", avg: 0.298, ops: 0.923, swing_pct: 68.3, whiff_pct: 18.9 },
    ],
    situational: [
      { label: "주자 없음", avg: 0.298, pa: 245, hr: 18, rbi: 18 },
      { label: "득점권", avg: 0.334, pa: 134, hr: 12, rbi: 67 },
      { label: "만루", avg: 0.375, pa: 16, hr: 2, rbi: 14 },
      { label: "vs 좌투", avg: 0.278, pa: 98, hr: 8, rbi: 22 },
      { label: "vs 우투", avg: 0.318, pa: 281, hr: 24, rbi: 63 },
      { label: "1~3회", avg: 0.312, pa: 142, hr: 11, rbi: 28 },
      { label: "7회 이후", avg: 0.345, pa: 98, hr: 12, rbi: 34 },
    ],
    hotZone: [
      [0.3, 0.7, 0.5],
      [0.8, 1.0, 0.6],
      [0.4, 0.6, 0.2],
    ],
  },
  p4: { // 김도영 (KIA)
    playerId: "p4", wRC: 172, OPS: 0.978, wOBA: 0.425, ISO: 0.289, BABIP: 0.345, BB_pct: 10.8, K_pct: 16.2, WAR: 7.2,
    pitchStats: [
      { type: "직구", avg: 0.334, ops: 1.045, swing_pct: 74.5, whiff_pct: 11.8 },
      { type: "슬라이더", avg: 0.301, ops: 0.912, swing_pct: 58.2, whiff_pct: 25.3 },
      { type: "체인지업", avg: 0.278, ops: 0.834, swing_pct: 51.7, whiff_pct: 28.9 },
      { type: "커브", avg: 0.256, ops: 0.756, swing_pct: 38.4, whiff_pct: 19.2 },
      { type: "커터", avg: 0.312, ops: 0.967, swing_pct: 71.2, whiff_pct: 15.6 },
    ],
    situational: [
      { label: "주자 없음", avg: 0.318, pa: 268, hr: 22, rbi: 22 },
      { label: "득점권", avg: 0.356, pa: 148, hr: 14, rbi: 78 },
      { label: "만루", avg: 0.412, pa: 17, hr: 3, rbi: 18 },
      { label: "vs 좌투", avg: 0.298, pa: 112, hr: 10, rbi: 28 },
      { label: "vs 우투", avg: 0.342, pa: 304, hr: 26, rbi: 72 },
      { label: "1~3회", avg: 0.328, pa: 156, hr: 13, rbi: 32 },
      { label: "7회 이후", avg: 0.367, pa: 108, hr: 14, rbi: 42 },
    ],
    hotZone: [
      [0.5, 0.9, 0.7],
      [0.9, 1.0, 0.8],
      [0.6, 0.7, 0.3],
    ],
  },
  p10: { // 김하성 (두산)
    playerId: "p10", wRC: 142, OPS: 0.898, wOBA: 0.389, ISO: 0.198, BABIP: 0.328, BB_pct: 11.2, K_pct: 14.8, WAR: 5.1,
    pitchStats: [
      { type: "직구", avg: 0.305, ops: 0.912, swing_pct: 70.3, whiff_pct: 12.8 },
      { type: "슬라이더", avg: 0.278, ops: 0.823, swing_pct: 52.8, whiff_pct: 24.1 },
      { type: "체인지업", avg: 0.234, ops: 0.689, swing_pct: 46.5, whiff_pct: 30.2 },
      { type: "커브", avg: 0.289, ops: 0.845, swing_pct: 44.2, whiff_pct: 20.8 },
      { type: "커터", avg: 0.312, ops: 0.901, swing_pct: 65.7, whiff_pct: 16.4 },
    ],
    situational: [
      { label: "주자 없음", avg: 0.287, pa: 232, hr: 12, rbi: 12 },
      { label: "득점권", avg: 0.321, pa: 128, hr: 8, rbi: 56 },
      { label: "만루", avg: 0.333, pa: 12, hr: 1, rbi: 10 },
      { label: "vs 좌투", avg: 0.312, pa: 96, hr: 7, rbi: 21 },
      { label: "vs 우투", avg: 0.295, pa: 264, hr: 13, rbi: 47 },
      { label: "1~3회", avg: 0.298, pa: 134, hr: 8, rbi: 24 },
      { label: "7회 이후", avg: 0.318, pa: 92, hr: 8, rbi: 28 },
    ],
    hotZone: [
      [0.4, 0.8, 0.6],
      [0.7, 0.9, 0.7],
      [0.5, 0.6, 0.4],
    ],
  },
};

export const PITCHER_ADVANCED: Record<string, PitcherAdvanced> = {
  p2: { // 양현종 (KIA)
    playerId: "p2", FIP: 3.12, xFIP: 3.28, WHIP: 1.08, K9: 8.4, BB9: 2.1, HR9: 0.78, WAR: 4.8, LOB_pct: 76.2, GB_pct: 48.5,
    pitchMix: [
      { type: "직구", pct: 38.2, velo: 145.8, spin: 2245, whiff_pct: 18.4 },
      { type: "슬라이더", pct: 24.5, velo: 134.2, spin: 2456, whiff_pct: 32.1 },
      { type: "체인지업", pct: 18.8, velo: 136.5, spin: 1678, whiff_pct: 28.7 },
      { type: "커브", pct: 12.3, velo: 124.8, spin: 2689, whiff_pct: 24.5 },
      { type: "커터", pct: 6.2, velo: 140.1, spin: 2312, whiff_pct: 22.3 },
    ],
    situational: [
      { label: "주자 없음", avg: 0.228, pa: 345, k: 78, bb: 28 },
      { label: "득점권", avg: 0.245, pa: 156, k: 42, bb: 18 },
      { label: "vs 좌타", avg: 0.234, pa: 198, k: 52, bb: 22 },
      { label: "vs 우타", avg: 0.241, pa: 303, k: 68, bb: 24 },
      { label: "1~3회", avg: 0.218, pa: 178, k: 45, bb: 12 },
      { label: "7회 이후", avg: 0.256, pa: 98, k: 24, bb: 14 },
    ],
  },
  p5: { // 문동주 (한화)
    playerId: "p5", FIP: 2.89, xFIP: 3.05, WHIP: 1.02, K9: 9.8, BB9: 2.4, HR9: 0.65, WAR: 5.4, LOB_pct: 78.8, GB_pct: 44.2,
    pitchMix: [
      { type: "직구", pct: 42.5, velo: 150.2, spin: 2378, whiff_pct: 22.1 },
      { type: "슬라이더", pct: 28.3, velo: 138.4, spin: 2567, whiff_pct: 36.8 },
      { type: "체인지업", pct: 16.2, velo: 140.1, spin: 1745, whiff_pct: 30.5 },
      { type: "커브", pct: 13.0, velo: 128.5, spin: 2712, whiff_pct: 26.2 },
    ],
    situational: [
      { label: "주자 없음", avg: 0.212, pa: 378, k: 98, bb: 32 },
      { label: "득점권", avg: 0.234, pa: 167, k: 48, bb: 22 },
      { label: "vs 좌타", avg: 0.225, pa: 212, k: 58, bb: 26 },
      { label: "vs 우타", avg: 0.218, pa: 333, k: 88, bb: 28 },
      { label: "1~3회", avg: 0.198, pa: 189, k: 52, bb: 14 },
      { label: "7회 이후", avg: 0.267, pa: 78, k: 18, bb: 12 },
    ],
  },
};

/* 기본 mock: 데이터 없는 선수용 */
export function getDefaultBatterAdvanced(playerId: string): BatterAdvanced {
  return {
    playerId, wRC: 105, OPS: 0.756, wOBA: 0.342, ISO: 0.156, BABIP: 0.298, BB_pct: 8.5, K_pct: 20.2, WAR: 2.1,
    pitchStats: [
      { type: "직구", avg: 0.278, ops: 0.812, swing_pct: 68.5, whiff_pct: 16.8 },
      { type: "슬라이더", avg: 0.245, ops: 0.712, swing_pct: 50.2, whiff_pct: 30.4 },
      { type: "체인지업", avg: 0.223, ops: 0.645, swing_pct: 44.8, whiff_pct: 34.2 },
      { type: "커브", avg: 0.234, ops: 0.678, swing_pct: 40.1, whiff_pct: 25.8 },
    ],
    situational: [
      { label: "주자 없음", avg: 0.268, pa: 210, hr: 8, rbi: 8 },
      { label: "득점권", avg: 0.285, pa: 108, hr: 5, rbi: 38 },
      { label: "vs 좌투", avg: 0.258, pa: 82, hr: 4, rbi: 14 },
      { label: "vs 우투", avg: 0.275, pa: 236, hr: 9, rbi: 32 },
    ],
    hotZone: [
      [0.3, 0.5, 0.4],
      [0.6, 0.7, 0.5],
      [0.3, 0.4, 0.2],
    ],
  };
}

export function getDefaultPitcherAdvanced(playerId: string): PitcherAdvanced {
  return {
    playerId, FIP: 3.85, xFIP: 3.92, WHIP: 1.28, K9: 7.2, BB9: 3.1, HR9: 1.02, WAR: 1.8, LOB_pct: 72.5, GB_pct: 42.8,
    pitchMix: [
      { type: "직구", pct: 40.0, velo: 144.5, spin: 2180, whiff_pct: 17.2 },
      { type: "슬라이더", pct: 25.0, velo: 132.8, spin: 2380, whiff_pct: 28.5 },
      { type: "체인지업", pct: 20.0, velo: 135.2, spin: 1620, whiff_pct: 25.8 },
      { type: "커브", pct: 15.0, velo: 122.4, spin: 2580, whiff_pct: 22.1 },
    ],
    situational: [
      { label: "주자 없음", avg: 0.248, pa: 298, k: 62, bb: 32 },
      { label: "득점권", avg: 0.268, pa: 142, k: 32, bb: 18 },
      { label: "vs 좌타", avg: 0.252, pa: 178, k: 38, bb: 22 },
      { label: "vs 우타", avg: 0.258, pa: 262, k: 56, bb: 28 },
    ],
  };
}
