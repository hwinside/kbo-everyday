// KBO 공식 선수 상세(HitterDetail/PitcherDetail Basic.aspx) HTML 파서.
// /api/player-stats 라우트에서 분리 — truncated fixture 실행 검증(qa:player-stats-parser)을 위해 모듈화.
//
// fail-close 계약(삼순 #1166 2차 NO-GO #2):
//  - 테이블(tbody) 부재·필수 열 개수 미달·t1 누락 등 부분/비정상 HTML은 throw(장애) — 0으로 오염된
//    성공 응답이 캐시되는 것을 차단한다.
//  - 명시적 "기록이 없습니다."만 null(기록 없음)로 반환한다.

export interface PitcherDetailStats {
  team: string; era: string; games: number;
  cg: number; sho: number; wins: number; losses: number;
  saves: number; holds: number; wpct: string | undefined;
  ip: string; hits: number; hr: number;
  bb: number; so: number; er: number; whip: string;
}

export interface BatterDetailStats {
  team: string; avg: string; games: number;
  pa: number; ab: number; runs: number; hits: number;
  doubles: number; triples: number; hr: number; tb: number;
  rbi: number; sb: number; cs: number; sac: number; sf: number; bb: number; hbp: number;
  so: number; slg: string; obp: string; ops: string;
}

export type PlayerDetailStats = PitcherDetailStats | BatterDetailStats;

// 필수 열 개수 — KBO 공식 테이블 레이아웃(아래 인덱스 주석) 기준. 미달 = 부분 HTML = 장애.
const PITCHER_T0_MIN_CELLS = 17; // 팀, ERA, G, CG, SHO, W, L, SV, HLD, WPCT, TBF, NP, IP, H, 2B, 3B, HR
const PITCHER_T1_MIN_CELLS = 13; // SAC, SF, BB, IBB, SO, WP, BK, R, ER, BSV, WHIP, AVG, QS
const BATTER_T0_MIN_CELLS = 16; // 팀, AVG, G, PA, AB, R, H, 2B, 3B, HR, TB, RBI, SB, CS, SAC, SF
const BATTER_T1_MIN_CELLS = 11; // BB, IBB, HBP, SO, GDP, SLG, OBP, E, SB%, MH, OPS, ...

export function parseTables(html: string): string[][][] {
  const result: string[][][] = [];
  const tbodies = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/gi) || [];
  for (const tb of tbodies) {
    const rows: string[][] = [];
    const trs = tb.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    for (const tr of trs) {
      const cells = (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
        .map(td => td.replace(/<[^>]+>/g, "").trim());
      if (cells.length > 0) rows.push(cells);
    }
    result.push(rows);
  }
  return result;
}

export function parsePlayerStats(html: string, isPitcher: boolean): PlayerDetailStats | null {
  const tables = parseTables(html);
  const t0 = tables[0]?.[0];
  const t1 = tables[1]?.[0];

  if (isPitcher) {
    // 테이블 자체가 없는 비정상 HTML은 장애로 취급(throw → no-store) — 명시적 '기록 없음'만 null.
    if (!t0) throw new Error("upstream parse anomaly: pitcher tables missing");
    if (t0[0] === "기록이 없습니다.") return null;
    // t1 누락·열 미달 = 부분 HTML: BB/SO/ER/WHIP가 0으로 오염된 채 성공 캐시되는 것 차단.
    if (t0.length < PITCHER_T0_MIN_CELLS || !t1 || t1.length < PITCHER_T1_MIN_CELLS) {
      throw new Error("upstream parse anomaly: pitcher stat columns truncated");
    }
    return {
      team: t0[0], era: t0[1], games: parseInt(t0[2]) || 0,
      cg: parseInt(t0[3]) || 0, sho: parseInt(t0[4]) || 0,
      wins: parseInt(t0[5]) || 0, losses: parseInt(t0[6]) || 0,
      saves: parseInt(t0[7]) || 0, holds: parseInt(t0[8]) || 0,
      wpct: t0[9], ip: t0[12], hits: parseInt(t0[13]) || 0, hr: parseInt(t0[16]) || 0,
      bb: parseInt(t1[2]) || 0, so: parseInt(t1[4]) || 0,
      er: parseInt(t1[8]) || 0, whip: t1[10] || "0.00",
    };
  }

  if (!t0) throw new Error("upstream parse anomaly: hitter tables missing");
  if (t0[0] === "기록이 없습니다.") return null;
  if (t0.length < BATTER_T0_MIN_CELLS || !t1 || t1.length < BATTER_T1_MIN_CELLS) {
    throw new Error("upstream parse anomaly: hitter stat columns truncated");
  }
  return {
    team: t0[0], avg: t0[1], games: parseInt(t0[2]) || 0,
    pa: parseInt(t0[3]) || 0, ab: parseInt(t0[4]) || 0,
    runs: parseInt(t0[5]) || 0, hits: parseInt(t0[6]) || 0,
    doubles: parseInt(t0[7]) || 0, triples: parseInt(t0[8]) || 0,
    hr: parseInt(t0[9]) || 0, tb: parseInt(t0[10]) || 0,
    rbi: parseInt(t0[11]) || 0, sb: parseInt(t0[12]) || 0,
    cs: parseInt(t0[13]) || 0, sac: parseInt(t0[14]) || 0, sf: parseInt(t0[15]) || 0,
    bb: parseInt(t1[0]) || 0, hbp: parseInt(t1[2]) || 0,
    so: parseInt(t1[3]) || 0,
    slg: t1[5] || ".000", obp: t1[6] || ".000", ops: t1[10] || ".000",
  };
}
