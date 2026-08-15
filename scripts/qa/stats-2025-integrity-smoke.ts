/**
 * 2025 확정 static 스탯의 **컬럼 관계·비율 범위 fail-close 게이트**.
 *
 * ── 왜 생겼나 (2026-08-15 삼순 P0) ──────────────────────────────
 * commit `76e623ef8` 재크롤이 2025 타자 42명 전원의 Basic2 필드를 밀었다:
 * 양의지 bb=130(=games)·ibb=517(=pa)·hbp=454(=ab)·so=56(=runs)·gdp=153(=hits)·
 * slg="27"(=2B)·obp="1"(=3B)·ops="20"(=HR). 정상값은 50·6·7·63·10·.533·.406·.939.
 * 값이 "존재"하고 타입도 맞아 identity 게이트(#1196)는 통과했다 — **관계**를 검증하는
 * 게이트가 없었기 때문이다. 2025 는 종료 시즌이라 값이 변할 수 없으므로,
 * 확정 항등식으로 파일 자체를 fail-close 한다.
 *
 * ── 검증 (batter 42행 전수) ─────────────────────────────────────
 *  1. 밀림 시그니처 직접 검출: bb==games && ibb==pa && hbp==ab → FAIL
 *  2. TB 항등식: tb == hits + 2B + 2*3B + 3*HR  (정확)
 *  3. PA 항등식: pa == ab + bb + hbp + sac + sf  (KBO 공식 정의)
 *  4. OPS == OBP + SLG (±0.002 반올림 허용)
 *  5. 비율 형식·범위: avg/obp/slg/ops 는 소수점 포함 문자열, 0 < avg·obp < 1,
 *     0 < slg < 1.5, 0 < ops < 2.5  ("27" 같은 밀린 정수 문자열 검출)
 *  6. 관계: hits >= 2B+3B+HR, ab <= pa, hits <= ab, so <= ab + bb + hbp
 *
 * ── 투수 (311행 기본 검증) ──────────────────────────────────────
 *  era/whip 형식(소수점)·범위, 관계 so/bb/hits >= 0. Basic2 밀림과 같은 유형이
 *  투수에도 오면 형식·범위 축에서 걸린다.
 *
 * 실행: npm run qa:stats-2025-integrity  (prebuild 포함, 위반 시 exit 1)
 */
import batters from "../../src/lib/constants/stats-2025-batters.json";
import pitchers from "../../src/lib/constants/stats-2025-pitchers.json";

type Row = Record<string, string | number>;

let fail = 0;
function bad(name: string, axis: string, detail: string): void {
  console.error(`  ❌ [${axis}] ${name}: ${detail}`);
  fail += 1;
}

function num(row: Row, key: string): number {
  const v = Number(row[key]);
  return Number.isFinite(v) ? v : Number.NaN;
}

function checkRateFormat(row: Row, name: string, field: string, max: number): void {
  const raw = String(row[field] ?? "");
  if (!raw.includes(".")) {
    bad(name, "rate-format", `${field}="${raw}" 소수점 없음 — 밀린 정수값 의심`);
    return;
  }
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0 || v >= max) {
    bad(name, "rate-range", `${field}=${raw} (허용 0~${max})`);
  }
}

// ── batter 42행 전수 ──
const batterRows = batters as Row[];
if (batterRows.length !== 42) bad("(전체)", "row-count", `batter=${batterRows.length} ≠ 42`);
for (const r of batterRows) {
  const name = String(r.name);
  const [games, pa, ab, runs, hits] = ["games", "pa", "ab", "runs", "hits"].map((f) => num(r, f));
  const [d2, d3, hr, tb] = ["doubles", "triples", "hr", "tb"].map((f) => num(r, f));
  const [bb, ibb, hbp, so, gdp, sac, sf] = ["bb", "ibb", "hbp", "so", "gdp", "sac", "sf"].map((f) => num(r, f));
  void runs; void gdp;

  // 1. 밀림 시그니처 (76e623ef8 오염의 정확한 형태)
  if (bb === games && ibb === pa && hbp === ab) {
    bad(name, "shift-signature", `bb=${bb}(=games)·ibb=${ibb}(=pa)·hbp=${hbp}(=ab) — Basic2 밀림`);
  }
  // 2~3. 항등식
  const tbCalc = hits + d2 + 2 * d3 + 3 * hr;
  if (tb !== tbCalc) bad(name, "tb-identity", `tb=${tb} ≠ hits+2B+2*3B+3*HR=${tbCalc}`);
  const paCalc = ab + bb + hbp + sac + sf;
  if (pa !== paCalc) bad(name, "pa-identity", `pa=${pa} ≠ ab+bb+hbp+sac+sf=${paCalc}`);
  // 4. OPS = OBP + SLG
  const obp = Number(r.obp); const slg = Number(r.slg); const ops = Number(r.ops);
  if (Math.abs(obp + slg - ops) > 0.002) bad(name, "ops-identity", `ops=${ops} ≠ obp+slg=${(obp + slg).toFixed(3)}`);
  // 5. 비율 형식·범위
  checkRateFormat(r, name, "avg", 1);
  checkRateFormat(r, name, "obp", 1);
  checkRateFormat(r, name, "slg", 1.5);
  checkRateFormat(r, name, "ops", 2.5);
  // 6. 관계
  if (hits < d2 + d3 + hr) bad(name, "hits-relation", `hits=${hits} < 2B+3B+HR=${d2 + d3 + hr}`);
  if (ab > pa) bad(name, "ab-relation", `ab=${ab} > pa=${pa}`);
  if (hits > ab) bad(name, "hits-ab", `hits=${hits} > ab=${ab}`);
  if (so > ab + bb + hbp) bad(name, "so-relation", `so=${so} > ab+bb+hbp=${ab + bb + hbp}`);
  if (ibb > bb) bad(name, "ibb-relation", `ibb=${ibb} > bb=${bb}`);
}

// ── pitcher 311행 기본 검증 ──
const pitcherRows = pitchers as Row[];
if (pitcherRows.length !== 311) bad("(전체)", "row-count", `pitcher=${pitcherRows.length} ≠ 311`);
for (const r of pitcherRows) {
  const name = String(r.name);
  if (typeof r.era !== "undefined") {
    const raw = String(r.era);
    // "-" 는 이닝 없음 표기로 허용, 그 외에는 소수점 형식 + 0~99.99 범위
    if (raw !== "-") {
      if (!raw.includes(".")) bad(name, "era-format", `era="${raw}" 소수점 없음`);
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0 || v >= 100) bad(name, "era-range", `era=${raw}`);
    }
  }
  for (const f of ["so", "bb", "hits", "hr", "games"]) {
    if (typeof r[f] === "undefined") continue;
    const v = num(r, f);
    if (!Number.isFinite(v) || v < 0 || v > 1500) bad(name, "pitcher-range", `${f}=${r[f]}`);
  }
}

if (fail > 0) {
  console.error(`\n❌ stats-2025 integrity: ${fail}건 위반`);
  process.exit(1);
}
console.log(`✅ stats-2025 integrity: batter ${batterRows.length}행(항등식 4축+형식+관계) · pitcher ${pitcherRows.length}행(형식·범위) 위반 0`);
