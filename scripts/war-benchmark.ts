/**
 * 내부 전용 — 자체 "예상 WAR" vs 네이버 WAR 오차 벤치마크 (서비스 미노출).
 * 하린아빠 (다) 결정: 표시는 자체 예상 WAR, 정확도 기준은 네이버 WAR(스탯티즈 대체).
 * 실행: npx tsx scripts/war-benchmark.ts [season]
 * 네이버 stats API(api-gw.sports.naver.com)에서 타자 WAR + 타격스탯을 받아
 * 동일 입력으로 자체 산식을 돌려 평균절대오차/상관/최대 괴리 선수를 출력한다.
 * 이 출력으로 산식을 상시 개선한다(수비/포지션 보강 효과 추적).
 */
import { calcBatterSaber, calcPitcherSaber } from "../src/lib/utils/sabermetrics-calc";
import positions from "../src/lib/constants/player-positions.json";

const POS = positions as Record<string, string>;
// 수비는 WAR 미반영(하린아빠 결정, 네이버 SSOT) — 벤치마크도 UI와 동일 기준(수비 제외)으로 측정

const SEASON = process.argv[2] || "2026";
const BASE = "https://api-gw.sports.naver.com/statistics/categories/kbo/seasons";

type NaverHitter = {
  playerId: string; playerName: string; teamShortName: string; hitterWar: number | null;
  hitterHra: string; hitterHit: number; hitterHr: number; hitterH2: number; hitterH3: number;
  hitterAb: number; hitterRun: number; hitterRbi: number; hitterSb: number; hitterCs: number | null;
  hitterBb: number; hitterHp: number; hitterKk: number; isQualified: boolean;
};

type NaverPitcher = {
  playerId: string; playerName: string; teamShortName: string; pitcherWar: number | null;
  pitcherEra: number; pitcherInning: number | string; pitcherKk: number; pitcherBb: number;
  pitcherHr: number; pitcherHit: number; pitcherR: number; pitcherEr: number; pitcherGameCount: number;
  pitcherWin: number; pitcherLose: number; pitcherSave: number; pitcherWhip: number; isQualified: boolean;
};

async function fetchAll<T extends { playerId: string }>(playerType: string): Promise<T[]> {
  const byId = new Map<string, T>();
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${BASE}/${SEASON}/players?playerType=${playerType}&gameType=REGULAR_SEASON&page=${page}&pageSize=100`,
      { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://m.sports.naver.com/" } });
    if (!r.ok) break;
    const j = await r.json();
    const rows: T[] = j?.result?.seasonPlayerStats ?? [];
    if (!rows.length) break;
    const before = byId.size;
    for (const x of rows) if (x.playerId && !byId.has(x.playerId)) byId.set(x.playerId, x);
    if (byId.size === before) break;
  }
  return [...byId.values()];
}

type Diff = { name: string; team: string; ours: number; naver: number; d: number };

function report(title: string, diffs: Diff[], note: string) {
  const n = diffs.length || 1;
  const mae = diffs.reduce((s, x) => s + Math.abs(x.d), 0) / n;
  const bias = diffs.reduce((s, x) => s + x.d, 0) / n;
  const mo = diffs.reduce((s, x) => s + x.ours, 0) / n, mn = diffs.reduce((s, x) => s + x.naver, 0) / n;
  let cov = 0, vo = 0, vn = 0;
  for (const x of diffs) { cov += (x.ours - mo) * (x.naver - mn); vo += (x.ours - mo) ** 2; vn += (x.naver - mn) ** 2; }
  const corr = vo && vn ? cov / Math.sqrt(vo * vn) : 0;
  // 최소제곱 캘리브레이션 제안: naver ≈ a*ours + b
  const a = vo ? cov / vo : 1, b = mn - a * mo;
  const calMae = diffs.reduce((s, x) => s + Math.abs((a * x.ours + b) - x.naver), 0) / n;
  console.log(`\n=== ${title} (n=${n}) ===`);
  console.log(`평균절대오차(MAE): ${mae.toFixed(2)}  편향(bias, ours-naver): ${bias.toFixed(2)}  상관: ${corr.toFixed(3)}`);
  console.log(`추천 캘리브레이션 a=${a.toFixed(3)} b=${b.toFixed(3)} → 적용시 MAE ${calMae.toFixed(2)}`);
  // 상대오차(%) — 네이버 절대값 기준(0 근처 분모 왜곡 방지 위해 |naver|>=0.5만)
  const rel = diffs.filter((x) => Math.abs(x.naver) >= 0.5).map((x) => Math.abs(x.d) / Math.abs(x.naver) * 100);
  rel.sort((p, q) => p - q);
  const med = rel.length ? rel[Math.floor(rel.length / 2)] : 0;
  const mean = rel.length ? rel.reduce((s, v) => s + v, 0) / rel.length : 0;
  const within = (t: number) => rel.length ? (rel.filter((v) => v <= t).length / rel.length * 100) : 0;
  console.log(`상대오차(|naver|≥0.5, n=${rel.length}): 중앙 ${med.toFixed(1)}% 평균 ${mean.toFixed(1)}% | ≤3% ${within(3).toFixed(0)}% · ≤5% ${within(5).toFixed(0)}% · ≤10% ${within(10).toFixed(0)}% · ≤20% ${within(20).toFixed(0)}%`);
  console.log(`괴리 큰 선수 top 10 (${note}):`);
  [...diffs].sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 10).forEach((x) =>
    console.log(`  ${x.name}(${x.team})  자체 ${x.ours.toFixed(1)}  네이버 ${x.naver.toFixed(1)}  Δ${x.d > 0 ? "+" : ""}${x.d.toFixed(1)}`));
}

async function main() {
  // 타자
  const hitters = (await fetchAll<NaverHitter>("HITTER")).filter((h) => typeof h.hitterWar === "number" && h.isQualified);
  const bDiffs: Diff[] = hitters.map((h) => {
    const ours = calcBatterSaber({
      avg: h.hitterHra, hits: h.hitterHit, hr: h.hitterHr, doubles: h.hitterH2, triples: h.hitterH3,
      ab: h.hitterAb, pa: h.hitterAb + h.hitterBb + h.hitterHp, runs: h.hitterRun, rbi: h.hitterRbi,
      sb: h.hitterSb, bb: h.hitterBb, so: h.hitterKk, hbp: h.hitterHp, cs: h.hitterCs ?? 0, position: POS[h.playerId],
    }).WAR;
    return { name: h.playerName, team: h.teamShortName, ours, naver: h.hitterWar as number, d: ours - (h.hitterWar as number) };
  });

  // 투수
  const pitchers = (await fetchAll<NaverPitcher>("PITCHER")).filter((p) => typeof p.pitcherWar === "number" && p.isQualified);
  const pDiffs: Diff[] = pitchers.map((p) => {
    const ours = calcPitcherSaber({
      era: p.pitcherEra, ip: p.pitcherInning, so: p.pitcherKk, bb: p.pitcherBb, hr: p.pitcherHr,
      hits: p.pitcherHit, r: p.pitcherR, er: p.pitcherEr, games: p.pitcherGameCount, wins: p.pitcherWin, losses: p.pitcherLose,
      saves: p.pitcherSave, whip: p.pitcherWhip,
    }).WAR;
    return { name: p.playerName, team: p.teamShortName, ours, naver: p.pitcherWar as number, d: ours - (p.pitcherWar as number) };
  });

  console.log(`[war-benchmark] season=${SEASON} 자격타자=${bDiffs.length} 자격투수=${pDiffs.length} (네이버 WAR 보유)`);
  report("타자 예상 WAR vs 네이버 WAR", bDiffs, "포지션/수비 보강 후보");
  report("투수 예상 WAR vs 네이버 WAR", pDiffs, "FIP 외 요인");
}

main().catch((e) => { console.error(e); process.exit(1); });
