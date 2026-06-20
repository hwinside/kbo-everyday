/**
 * 내부 전용 — 자체 "예상 WAR" vs 네이버 WAR 오차 벤치마크 (서비스 미노출).
 * 하린아빠 (다) 결정: 표시는 자체 예상 WAR, 정확도 기준은 네이버 WAR(스탯티즈 대체).
 * 실행: npx tsx scripts/war-benchmark.ts [season]
 * 네이버 stats API(api-gw.sports.naver.com)에서 타자 WAR + 타격스탯을 받아
 * 동일 입력으로 자체 산식을 돌려 평균절대오차/상관/최대 괴리 선수를 출력한다.
 * 이 출력으로 산식을 상시 개선한다(수비/포지션 보강 효과 추적).
 */
import { calcBatterSaber } from "../src/lib/utils/sabermetrics-calc";
import positions from "../src/lib/constants/player-positions.json";

const POS = positions as Record<string, string>;

const SEASON = process.argv[2] || "2026";
const BASE = "https://api-gw.sports.naver.com/statistics/categories/kbo/seasons";

type NaverHitter = {
  playerId: string; playerName: string; teamShortName: string; hitterWar: number | null;
  hitterHra: string; hitterHit: number; hitterHr: number; hitterH2: number; hitterH3: number;
  hitterAb: number; hitterRun: number; hitterRbi: number; hitterSb: number; hitterCs: number | null;
  hitterBb: number; hitterHp: number; hitterKk: number; isQualified: boolean;
};

async function fetchAllHitters(): Promise<NaverHitter[]> {
  const byId = new Map<string, NaverHitter>();
  // page 파라미터가 무시될 수 있어 playerId 중복 제거 + 새 선수 0이면 중단
  for (let page = 1; page <= 20; page++) {
    const url = `${BASE}/${SEASON}/players?playerType=HITTER&gameType=REGULAR_SEASON&page=${page}&pageSize=100`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://m.sports.naver.com/" } });
    if (!res.ok) break;
    const json = await res.json();
    const rows: NaverHitter[] = json?.result?.seasonPlayerStats ?? [];
    if (rows.length === 0) break;
    const before = byId.size;
    for (const r of rows) if (r.playerId && !byId.has(r.playerId)) byId.set(r.playerId, r);
    if (byId.size === before) break; // 새 선수 없음 → 페이지네이션 끝(or 무시됨)
  }
  return [...byId.values()];
}

async function main() {
  const hitters = (await fetchAllHitters()).filter((h) => typeof h.hitterWar === "number" && h.isQualified);
  console.log(`[war-benchmark] season=${SEASON} 자격타자=${hitters.length}명 (네이버 WAR 보유)`);

  const diffs: { name: string; team: string; ours: number; naver: number; d: number }[] = [];
  for (const h of hitters) {
    const ours = calcBatterSaber({
      avg: h.hitterHra, hits: h.hitterHit, hr: h.hitterHr, doubles: h.hitterH2, triples: h.hitterH3,
      ab: h.hitterAb, pa: h.hitterAb + h.hitterBb + h.hitterHp, // PA 근사(SF/SH 제외)
      runs: h.hitterRun, rbi: h.hitterRbi, sb: h.hitterSb, bb: h.hitterBb, so: h.hitterKk,
      hbp: h.hitterHp, cs: h.hitterCs ?? 0, position: POS[h.playerId],
    }).WAR;
    const naver = h.hitterWar as number;
    diffs.push({ name: h.playerName, team: h.teamShortName, ours, naver, d: ours - naver });
  }

  const n = diffs.length || 1;
  const mae = diffs.reduce((s, x) => s + Math.abs(x.d), 0) / n;
  const bias = diffs.reduce((s, x) => s + x.d, 0) / n;
  // 피어슨 상관
  const mo = diffs.reduce((s, x) => s + x.ours, 0) / n, mn = diffs.reduce((s, x) => s + x.naver, 0) / n;
  let cov = 0, vo = 0, vn = 0;
  for (const x of diffs) { cov += (x.ours - mo) * (x.naver - mn); vo += (x.ours - mo) ** 2; vn += (x.naver - mn) ** 2; }
  const corr = vo && vn ? cov / Math.sqrt(vo * vn) : 0;

  console.log(`\n=== 타자 예상 WAR vs 네이버 WAR ===`);
  console.log(`평균절대오차(MAE): ${mae.toFixed(2)}  편향(bias, ours-naver): ${bias.toFixed(2)}  상관: ${corr.toFixed(3)}`);
  console.log(`\n괴리 큰 선수 top 12 (수비/포지션 보강 후보):`);
  diffs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  for (const x of diffs.slice(0, 12)) {
    console.log(`  ${x.name}(${x.team})  자체 ${x.ours.toFixed(1)}  네이버 ${x.naver.toFixed(1)}  Δ${x.d > 0 ? "+" : ""}${x.d.toFixed(1)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
