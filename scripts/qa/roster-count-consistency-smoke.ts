/**
 * roster 카운트 정합 정적 회귀 스모크 — 2026-07-26 삼순 조건부 GO 요청(#871).
 * 실행: npx tsx scripts/qa/roster-count-consistency-smoke.ts  (npm run qa:roster-count-consistency)
 *
 * 강제 불변식(삼순 지정):
 *   players-roster.json.length === roster route EXPECTED_ROSTER_COUNT === health route EXPECTED_ROSTER_COUNT
 *
 * 배경: 신규 선수 온보딩(예: 짐머맨 56799, 876→877) 시 roster SSOT는 +1 되는데
 * roster/route.ts·health/roster/route.ts의 EXPECTED_ROSTER_COUNT 상수를 같이 안 올리면
 * health GET이 'roster count mismatch'로 503 낸다(실제 발생). 이 스모크가 세 값의
 * drift를 CI에서 차단한다.
 */
import fs from "fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✓ ${name} (${JSON.stringify(got)})`);
    pass++;
  } else {
    console.error(`✗ ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
    fail++;
  }
}

/** 소스에서 `const EXPECTED_ROSTER_COUNT = <n>;` 정수를 추출. */
function readExpectedConst(relPath: string): number {
  const src = fs.readFileSync(path.join(ROOT, relPath), "utf8");
  const m = src.match(/EXPECTED_ROSTER_COUNT\s*=\s*(\d+)/);
  if (!m) throw new Error(`EXPECTED_ROSTER_COUNT not found in ${relPath}`);
  return Number(m[1]);
}

const roster = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src/lib/constants/players-roster.json"), "utf8"),
) as unknown[];
const rosterLen = roster.length;

const rosterRouteExpected = readExpectedConst("src/app/api/roster/route.ts");
const healthRouteExpected = readExpectedConst("src/app/api/health/roster/route.ts");

// 불변식: 세 값이 모두 동일해야 함(drift = health 503 위험).
check("roster route EXPECTED_ROSTER_COUNT === roster JSON length", rosterRouteExpected, rosterLen);
check("health route EXPECTED_ROSTER_COUNT === roster JSON length", healthRouteExpected, rosterLen);
check("roster route === health route (두 API 상수 동일)", rosterRouteExpected, healthRouteExpected);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — roster count consistency (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
