/**
 * Regression: player profile hexagon radar axes must never go negative.
 *
 * Bug (2026-07-28): a high-strikeout batter (e.g. 김형준, NC) drove
 * 안정감 = 1 - (so/pa)/0.25 below 0, which drew the vertex past the chart
 * center and folded the hexagon inward ("Z" shape). All axes must clamp to
 * [0,100].
 *
 * Run: npx tsx scripts/qa/player-radar-clamp-smoke.ts
 */
import {
  calcBatterRadar,
  calcPitcherRadar,
  type BatterStatsRaw,
  type PitcherStatsRaw,
} from "../../src/lib/utils/player-radar";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function inRange(axes: { label: string; value: number }[], ctx: string) {
  for (const a of axes) {
    check(
      `${ctx} :: ${a.label} in [0,100]`,
      a.value >= 0 && a.value <= 100 && Number.isFinite(a.value),
      `got ${a.value}`,
    );
  }
}

console.log("[player-radar-clamp] batter");

// The reported bug case: high strikeout rate → 안정감 would be negative unclamped.
const highK: BatterStatsRaw = {
  avg: 0.25, obp: 0.31, slg: 0.45, pa: 200, bb: 15, so: 80, sb: 0,
};
const highKRadar = calcBatterRadar(highK);
inRange(highKRadar, "highK");
const stability = highKRadar.find((a) => a.label === "안정감")!;
// so/pa = 0.4 → (1 - 0.4/0.25) = -0.6 → -60 unclamped; must clamp to 0.
check("highK 안정감 clamps to 0 (was -60 unclamped)", stability.value === 0, `got ${stability.value}`);

// Extreme: everyone strikes out.
inRange(calcBatterRadar({ avg: 0, obp: 0, slg: 0, pa: 100, bb: 0, so: 100, sb: 0 }), "allK");

// Elite line must still cap at 100, not overflow.
const elite = calcBatterRadar({ avg: 0.4, obp: 0.5, slg: 0.8, pa: 600, bb: 120, so: 40, sb: 60 });
inRange(elite, "elite");
check("elite 타격 caps at 100", elite.find((a) => a.label === "타격")!.value === 100);
check("elite 주루 caps at 100", elite.find((a) => a.label === "주루")!.value === 100);

// Zero / missing stats must not NaN or go negative.
inRange(calcBatterRadar({ avg: "", obp: "", slg: "", pa: 0, bb: 0, so: 0, sb: 0 }), "empty");

console.log("[player-radar-clamp] pitcher");
inRange(calcPitcherRadar({ era: 9.99, whip: 2.5, ip: 5, so: 1, bb: 20 }), "badPitcher");
inRange(calcPitcherRadar({ era: 1.5, whip: 0.9, ip: 200, so: 250, bb: 20 }), "acePitcher");
inRange(calcPitcherRadar({ era: "", whip: "", ip: 0, so: 0, bb: 0 }), "emptyPitcher");

console.log(`\n[player-radar-clamp] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
