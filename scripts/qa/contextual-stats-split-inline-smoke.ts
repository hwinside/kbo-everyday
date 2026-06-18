/**
 * Smoke for formatSplitInline (src/lib/contextual-stats/format.ts).
 *
 * 회귀 가드: 투수 split의 "타수" 오표기 재발 방지. KBO Situation 표는 투수에
 * 실제 타수(AB)를 주지 않아 SplitRow.AB는 H+BB+SO 추정치다. 이를 "타수"로
 * 노출하면 피안타율과 모순된다(고객 제보: 소형준 좌타 .226인데 43타수 19안타).
 */

import { formatSplitInline } from "@/lib/contextual-stats/format";
import type { SplitRow } from "@/lib/contextual-stats/types";

let failed = 0;
function eq(name: string, got: string, want: string) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}: "${got}"${ok ? "" : ` (expected "${want}")`}`);
}

function row(over: Partial<SplitRow>): SplitRow {
  return { label: "좌타자", AVG: "-", AB: 0, H: 0, HR: 0, BB: 0, SO: 0, ...over };
}

// 고객 제보 케이스: 소형준 좌타 상대 — AVG .226, H 19, 프록시 AB 43(=H+BB+SO).
// 투수는 타수를 숨기고 피안타만 표시 → ".226 19피안타" (모순 제거).
const sohyungjun = row({ AVG: ".226", AB: 43, H: 19, BB: 12, SO: 12 });
eq("투수: 타수 숨김, 피안타만", formatSplitInline(sohyungjun, true), "19피안타");

// 타자는 실제 타수가 있으므로 기존 표기 유지.
eq("타자: 타수+안타 유지", formatSplitInline(sohyungjun, false), "43타수 19안타");

// HR 주석은 양쪽 모두 유지.
const withHr = row({ AVG: ".300", AB: 20, H: 6, HR: 2 });
eq("투수 + HR", formatSplitInline(withHr, true), "6피안타 (2HR)");
eq("타자 + HR", formatSplitInline(withHr, false), "20타수 6안타 (2HR)");

// 투수 표기에는 절대 "타수"가 들어가면 안 됨 (핵심 회귀 가드).
const pitcherStr = formatSplitInline(sohyungjun, true);
if (pitcherStr.includes("타수")) {
  failed++;
  console.log(`✗ 투수 표기에 "타수" 포함 금지: "${pitcherStr}"`);
} else {
  console.log(`✓ 투수 표기에 "타수" 미포함`);
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll passed");
