/**
 * roster 카운트 정합 정적 회귀 스모크 — 2026-07-26 삼순 조건부 GO 요청(#871).
 * 실행: npx tsx scripts/qa/roster-count-consistency-smoke.ts  (npm run qa:roster-count-consistency)
 *
 * 강제 불변식(삼순 지정, 2026-07-28 validator 상수 추가로 4값 확장):
 *   players-roster.json.length
 *     === roster route EXPECTED_ROSTER_COUNT
 *     === health route EXPECTED_ROSTER_COUNT
 *     === scripts/validate-roster.mjs EXPECTED_COUNT
 *
 * 배경: 신규 선수 온보딩(예: 짐머맨 56799 876→877, 보스 56402 877→878) 시 roster SSOT는
 * +1 되는데 세 상수(두 API + validator) 중 하나라도 같이 안 올리면:
 *   - API 상수 drift → health GET이 'roster count mismatch'로 503 (실제 발생)
 *   - validator 상수 drift → node scripts/validate-roster.mjs가 roster N vs expected 구값으로 exit 1
 *     (PR body의 roster-size-change ack로 마스킹되어 자동머지 green이 될 수 있음 → 이 스모크가 차단)
 * 이 스모크가 네 값의 drift를 CI(prebuild)에서 전부 차단한다.
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

/** validate-roster.mjs에서 `const EXPECTED_COUNT = <n>;` 정수를 추출. */
function readValidatorConst(relPath: string): number {
  const src = fs.readFileSync(path.join(ROOT, relPath), "utf8");
  const m = src.match(/EXPECTED_COUNT\s*=\s*(\d+)/);
  if (!m) throw new Error(`EXPECTED_COUNT not found in ${relPath}`);
  return Number(m[1]);
}

const roster = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src/lib/constants/players-roster.json"), "utf8"),
) as unknown[];
const rosterLen = roster.length;

const rosterRouteExpected = readExpectedConst("src/app/api/roster/route.ts");
const healthRouteExpected = readExpectedConst("src/app/api/health/roster/route.ts");
const validatorExpected = readValidatorConst("scripts/validate-roster.mjs");

// 불변식: 네 값이 모두 동일해야 함(API drift = health 503 / validator drift = validate-roster exit 1 위험).
check("roster route EXPECTED_ROSTER_COUNT === roster JSON length", rosterRouteExpected, rosterLen);
check("health route EXPECTED_ROSTER_COUNT === roster JSON length", healthRouteExpected, rosterLen);
check("validate-roster.mjs EXPECTED_COUNT === roster JSON length", validatorExpected, rosterLen);
check("roster route === health route (두 API 상수 동일)", rosterRouteExpected, healthRouteExpected);
check("validator === roster route (validator ↔ API 상수 동일)", validatorExpected, rosterRouteExpected);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — roster count consistency (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
