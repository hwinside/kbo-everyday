/**
 * KBO 기본 스탯에서 세이버메트릭스 계산
 */

const LEAGUE = {
  avg: 0.267, obp: 0.340, slg: 0.410, wOBA: 0.330,
  wOBAScale: 1.15, R_PA: 0.115,
  wBB: 0.69, wHBP: 0.72, w1B: 0.89, w2B: 1.27, w3B: 1.62, wHR: 2.10,
};

// 네이버 WAR 대비 최소제곱 캘리브레이션(naver ≈ a*ours + b). scripts/war-benchmark.ts로 주기 재산출.
// 2026 기준: 타자 MAE 0.29→0.27, 투수 MAE 0.37→0.31(투수 bias -0.20 보정).
const BATTER_WAR_CAL = { a: 0.909, b: 0.216 };
const PITCHER_WAR_CAL = { a: 0.956, b: 0.241 };

// 포지션 보정(시즌 ~600PA 기준 runs) — 네이버 position enum 기준
const POS_ADJ: Record<string, number> = {
  CATCHER: 12.5, SHORT_STOP: 7.5, SECOND_BASE: 3, THIRD_BASE: 2, CENTER_FIELDER: 2.5,
  LEFT_FIELDER: -7.5, RIGHT_FIELDER: -7.5, FIRST_BASE: -12.5, DESIGNATED_HITTER: -17.5,
};

// WAR 근사 계산 (Replacement level 기준) — "예상 WAR"
// 타자 WAR ≈ (Batting Runs + Baserunning Runs + Position Adj + Defense + Replacement) / RPW
// 반영: wRAA(타격) + 주루(SB/CS) + 포지션 보정 + 수비 runs(KBO 수비기록 RF-lite) + 대체선수.
// 수비 runs는 KBO 공식 수비기록(PO/A/E 등) 기반 자체 환산(scripts/lib/defense-runs.mjs).
// 내부 오차 벤치마크는 네이버 WAR(hitterWar)와 비교해 상시 축소(scripts/war-benchmark.ts).
function estimateBatterWAR(woba: number, pa: number, brRuns = 0, posRuns = 0, defRuns = 0): number {
  const wRAA = ((woba - 0.330) / 1.15) * pa;
  const replacement = (pa / 600) * 20; // ~20 runs per 600 PA
  const raw = (wRAA + brRuns + posRuns + defRuns + replacement) / 10;
  const war = BATTER_WAR_CAL.a * raw + BATTER_WAR_CAL.b; // 네이버 기준 캘리브레이션
  return Math.round(Math.max(war, -1) * 100) / 100; // 소수점 2자리(동률 변별)
}

/** KBO 이닝 표기 → 실제 이닝(thirds). "25 2/3"·"25 1/3" 분수 표기, "25.2"(thirds) 소수 표기, number 모두 처리 */
function parseInnings(ip: string | number): number {
  if (typeof ip === "string") {
    const m = ip.trim().match(/^(\d+)\s+(\d)\/3$/);
    if (m) return parseInt(m[1], 10) + parseInt(m[2], 10) / 3;
  }
  const n = typeof ip === "string" ? parseFloat(ip) : ip;
  if (!isFinite(n)) return 0;
  const whole = Math.floor(n);
  const frac = Math.round((n - whole) * 10); // .1=1/3, .2=2/3 (KBO thirds 소수 표기)
  return whole + (frac === 1 ? 1 / 3 : frac === 2 ? 2 / 3 : 0);
}

// 투수 WAR ≈ 실점 억제(RA9) 기반 — 네이버/스탯티즈 공표 투수 WAR이 실제 실점(RA9) 기반이라
// FIP 단독 추정은 BABIP·수비·시퀀싱 운으로 크게 어긋난다. ra9 = 9*R/IP(총실점 기준).
// (leagueRa9·replacement·RPW 상수는 네이버 기준 선형 캘리브레이션 a·x+b가 흡수)
function estimatePitcherWAR(ra9: number, fullIp: number): number {
  if (fullIp <= 0) return 0;
  const leagueRa9 = 5.00; // KBO 평균 실점/9 근사 (자책+비자책)
  const runsAboveAvg = ((leagueRa9 - ra9) / 9) * fullIp;
  const replacement = (fullIp / 9) * (leagueRa9 * 0.10); // 대체선수 대비 여유분
  const raw = (runsAboveAvg + replacement) / 10; // ~RPW(runs per win)
  const war = PITCHER_WAR_CAL.a * raw + PITCHER_WAR_CAL.b; // 네이버 기준 캘리브레이션
  return Math.round(Math.max(war, -1) * 100) / 100; // 소수점 2자리(동률 변별)
}

export interface CalcBatterSaber {
  OPS: number; OBP: number; SLG: number; ISO: number; BABIP: number;
  BB_pct: number; K_pct: number; wOBA: number; wRC_plus: number; WAR: number;
}

export interface CalcPitcherSaber {
  FIP: number; WHIP: number; K9: number; BB9: number; HR9: number;
  K_pct: number; BB_pct: number; WAR: number;
}

/**
 * 선수 페이지·기록실·야잘알봇이 함께 쓰는 타자 파생 스탯 입력 정규화.
 *
 * ⚠️ 종전에는 선수 페이지가 position 없이 WAR 5.22, 봇은 `THIRD_BASE` 보정을 넣어
 * 5.35를 답했다(김도영 production 실측, 삼순 #1100 6차). 같은 함수를 호출해도 **입력이
 * 다르면 다른 숫자**다. 그래서 row→calculator 변환 자체를 공용 helper 로 고정한다.
 * 현재 선수 페이지 계약을 보존하기 위해 position/defRuns 는 넣지 않는다.
 */
export function calcBatterSaberFromStats(
  stats: Record<string, unknown>,
): CalcBatterSaber | null {
  const pa = Number(stats.pa);
  const ab = Number(stats.ab);
  if (!pa || !ab) return null;
  return calcBatterSaber({
    avg: (stats.avg as string | number) ?? 0,
    hits: Number(stats.hits) || 0,
    hr: Number(stats.hr) || 0,
    doubles: Number(stats.doubles) || 0,
    triples: Number(stats.triples) || 0,
    ab,
    pa,
    runs: Number(stats.runs) || 0,
    rbi: Number(stats.rbi) || 0,
    sb: Number(stats.sb) || 0,
    bb: Number(stats.bb) || 0,
    so: Number(stats.so) || 0,
    hbp: Number(stats.hbp) || 0,
    cs: Number(stats.cs) || 0,
    sf: stats.sf != null ? Number(stats.sf) : undefined,
    obp: stats.obp as string | number | undefined,
    slg: stats.slg as string | number | undefined,
    ops: stats.ops as string | number | undefined,
  });
}

/** 선수 페이지 표기와 같은 소수 2자리 WAR. */
export function batterWarFromStats(stats: Record<string, unknown>): string | null {
  const saber = calcBatterSaberFromStats(stats);
  return saber && Number.isFinite(saber.WAR) ? saber.WAR.toFixed(2) : null;
}

/** KBO 공식 비율 스탯 파싱 — ".356"/"0.356"/number 모두 처리, 0 이하·비수치는 null(계산 폴백) */
function parseOfficialRate(v: string | number | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return isFinite(n) && n > 0 ? n : null;
}

export function calcBatterSaber(s: {
  avg: string|number; hits: number; hr: number; doubles: number; triples: number;
  ab: number; pa: number; runs: number; rbi: number; sb: number;
  bb?: number; so?: number; hbp?: number; cs?: number; sf?: number; position?: string; defRuns?: number;
  // KBO 공식 발표값 — 있으면 SSOT로 우선 사용(재계산 근사식과의 불일치 방지)
  obp?: string|number; slg?: string|number; ops?: string|number;
}): CalcBatterSaber {
  const avg = typeof s.avg === "string" ? parseFloat(s.avg) : s.avg;
  // 주루 runs 근사(wSB류): 도루 +0.2 / 도루실패 -0.4
  const brRuns = (s.sb || 0) * 0.2 - (s.cs || 0) * 0.4;
  // 포지션 보정 runs (시즌 환산: PA/600 비례)
  const posRuns = ((s.position && POS_ADJ[s.position]) || 0) * ((s.pa || 0) / 600);
  // 수비 runs (KBO 수비기록 기반 RF-lite, kboId로 주입)
  const defRuns = s.defRuns || 0;
  const singles = s.hits - s.doubles - s.triples - s.hr;
  const bb = s.bb ?? Math.round((s.pa - s.ab) * 0.75);
  const hbp = s.hbp ?? Math.round((s.pa - s.ab) * 0.1);
  const so = s.so ?? Math.round(s.ab * 0.18);
  // BABIP/OBP 분모용 SF — 실제 SF가 오면 그대로(정확), 없으면 잔차 추정(잔차엔 희생번트 SH가 섞여 BABIP 분모가 과대해질 수 있음)
  const sf = s.sf ?? Math.max(0, s.pa - s.ab - bb - hbp);
  // OBP/SLG/OPS: KBO 공식값이 오면 그대로(SSOT), 없을 때만 공식 분모로 계산.
  // OBP denominator = AB + BB + HBP + SF. PA에는 SH 등이 섞여 있어 쓰면 낮게 나온다.
  const obpDen = s.ab + bb + hbp + sf;
  const obp = parseOfficialRate(s.obp) ?? (obpDen > 0 ? (s.hits + bb + hbp) / obpDen : 0);
  const slg = parseOfficialRate(s.slg) ?? (s.ab > 0 ? (singles + s.doubles*2 + s.triples*3 + s.hr*4) / s.ab : 0);
  const ops = parseOfficialRate(s.ops) ?? (obp + slg);
  const iso = slg - avg;
  const bd = s.ab - so - s.hr + sf;
  const babip = bd > 0 ? (s.hits - s.hr) / bd : 0;
  const bbPct = s.pa > 0 ? (bb / s.pa) * 100 : 0;
  const kPct = s.pa > 0 ? (so / s.pa) * 100 : 0;
  const woba = s.pa > 0
    ? (LEAGUE.wBB*bb + LEAGUE.wHBP*hbp + LEAGUE.w1B*singles + LEAGUE.w2B*s.doubles + LEAGUE.w3B*s.triples + LEAGUE.wHR*s.hr) / s.pa : 0;
  const wrc = LEAGUE.R_PA > 0
    ? Math.round(((woba - LEAGUE.wOBA) / LEAGUE.wOBAScale + LEAGUE.R_PA) / LEAGUE.R_PA * 100) : 100;
  return {
    OPS: Math.round(ops*1000)/1000, OBP: Math.round(obp*1000)/1000,
    SLG: Math.round(slg*1000)/1000, ISO: Math.round(iso*1000)/1000,
    BABIP: Math.round(babip*1000)/1000, BB_pct: Math.round(bbPct*10)/10,
    K_pct: Math.round(kPct*10)/10, wOBA: Math.round(woba*1000)/1000, wRC_plus: wrc,
    WAR: estimateBatterWAR(woba, s.pa, brRuns, posRuns, defRuns),
  };
}

export function calcPitcherSaber(s: {
  era: string|number; ip: string|number; so: number; bb?: number; hr?: number;
  hits?: number; r?: number; er?: number; games: number; wins: number; losses: number; saves: number;
  whip: string|number;
}): CalcPitcherSaber {
  const whip = typeof s.whip === "string" ? parseFloat(s.whip) : s.whip;
  const fullIp = parseInnings(s.ip);
  const era = typeof s.era === "string" ? parseFloat(s.era) : s.era;
  const hitsA = s.hits ?? Math.round(whip * fullIp * 0.7);
  const bb = s.bb ?? Math.max(0, Math.round(whip * fullIp - hitsA));
  const hr = s.hr ?? Math.round(fullIp * 0.08);
  const bf = Math.round(fullIp * 3 + hitsA + bb);
  const k9 = fullIp > 0 ? (s.so / fullIp) * 9 : 0;
  const bb9 = fullIp > 0 ? (bb / fullIp) * 9 : 0;
  const hr9 = fullIp > 0 ? (hr / fullIp) * 9 : 0;
  const fip = fullIp > 0 ? ((13*hr + 3*bb - 2*s.so) / fullIp) + 3.20 : 0;
  const kPct = bf > 0 ? (s.so / bf) * 100 : 0;
  const bbPct = bf > 0 ? (bb / bf) * 100 : 0;
  // RA9 = 9*실점/IP. 총실점(R) 우선, 없으면 자책(ER) → ERA×IP/9 순 폴백.
  const runs = s.r ?? s.er ?? (isFinite(era) ? (era * fullIp) / 9 : 0);
  const ra9 = fullIp > 0 ? (runs * 9) / fullIp : 0;
  return {
    FIP: Math.round(fip*100)/100, WHIP: whip,
    K9: Math.round(k9*10)/10, BB9: Math.round(bb9*10)/10, HR9: Math.round(hr9*10)/10,
    K_pct: Math.round(kPct*10)/10, BB_pct: Math.round(bbPct*10)/10,
    WAR: estimatePitcherWAR(ra9, fullIp),
  };
}
