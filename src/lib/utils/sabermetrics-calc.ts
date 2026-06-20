/**
 * KBO 기본 스탯에서 세이버메트릭스 계산
 */

const LEAGUE = {
  avg: 0.267, obp: 0.340, slg: 0.410, wOBA: 0.330,
  wOBAScale: 1.15, R_PA: 0.115,
  wBB: 0.69, wHBP: 0.72, w1B: 0.89, w2B: 1.27, w3B: 1.62, wHR: 2.10,
};

// WAR 근사 계산 (Replacement level 기준) — "예상 WAR"
// 타자 WAR ≈ (Batting Runs + Baserunning Runs + Position Adj + Defense + Replacement) / RPW
// 현재 반영: wRAA(타격) + 주루(SB/CS) + 대체선수.
// 미반영(Vercel-native 소스 확보 전까지 보류 → "예상"): 수비 runs, 정밀 포지션 보정.
// 내부 오차 벤치마크는 네이버 WAR(hitterWar)와 비교해 상시 축소(scripts/war-benchmark.mjs).
function estimateBatterWAR(woba: number, pa: number, brRuns = 0): number {
  const wRAA = ((woba - 0.330) / 1.15) * pa;
  const replacement = (pa / 600) * 20; // ~20 runs per 600 PA
  const war = (wRAA + brRuns + replacement) / 10;
  return Math.round(Math.max(war, -1) * 10) / 10;
}

// 투수 WAR ≈ (League ERA - FIP) / 9 * IP / 9 + Replacement
function estimatePitcherWAR(fip: number, ip: number): number {
  const leagueEra = 4.50; // KBO 평균 근사
  const fullIp = Math.floor(ip) + (ip % 1) * 10 / 3;
  const runsAboveAvg = ((leagueEra - fip) / 9) * fullIp;
  const replacement = (fullIp / 200) * 12;
  const war = (runsAboveAvg + replacement) / 10;
  return Math.round(Math.max(war, -1) * 10) / 10;
}

export interface CalcBatterSaber {
  OPS: number; OBP: number; SLG: number; ISO: number; BABIP: number;
  BB_pct: number; K_pct: number; wOBA: number; wRC_plus: number; WAR: number;
}

export interface CalcPitcherSaber {
  FIP: number; WHIP: number; K9: number; BB9: number; HR9: number;
  K_pct: number; BB_pct: number; WAR: number;
}

export function calcBatterSaber(s: {
  avg: string|number; hits: number; hr: number; doubles: number; triples: number;
  ab: number; pa: number; runs: number; rbi: number; sb: number;
  bb?: number; so?: number; hbp?: number; cs?: number;
}): CalcBatterSaber {
  const avg = typeof s.avg === "string" ? parseFloat(s.avg) : s.avg;
  // 주루 runs 근사(wSB류): 도루 +0.2 / 도루실패 -0.4
  const brRuns = (s.sb || 0) * 0.2 - (s.cs || 0) * 0.4;
  const singles = s.hits - s.doubles - s.triples - s.hr;
  const bb = s.bb ?? Math.round((s.pa - s.ab) * 0.75);
  const hbp = s.hbp ?? Math.round((s.pa - s.ab) * 0.1);
  const so = s.so ?? Math.round(s.ab * 0.18);
  const sf = Math.max(0, s.pa - s.ab - bb - hbp);
  const obp = s.pa > 0 ? (s.hits + bb + hbp) / s.pa : 0;
  const slg = s.ab > 0 ? (singles + s.doubles*2 + s.triples*3 + s.hr*4) / s.ab : 0;
  const ops = obp + slg;
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
    WAR: estimateBatterWAR(woba, s.pa, brRuns),
  };
}

export function calcPitcherSaber(s: {
  era: string|number; ip: string|number; so: number; bb?: number; hr?: number;
  hits?: number; games: number; wins: number; losses: number; saves: number;
  whip: string|number;
}): CalcPitcherSaber {
  const ip = typeof s.ip === "string" ? parseFloat(s.ip) : s.ip;
  const whip = typeof s.whip === "string" ? parseFloat(s.whip) : s.whip;
  const fullIp = Math.floor(ip) + (ip % 1) * 10 / 3;
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
  return {
    FIP: Math.round(fip*100)/100, WHIP: whip,
    K9: Math.round(k9*10)/10, BB9: Math.round(bb9*10)/10, HR9: Math.round(hr9*10)/10,
    K_pct: Math.round(kPct*10)/10, BB_pct: Math.round(bbPct*10)/10,
    WAR: estimatePitcherWAR(fip, ip),
  };
}
