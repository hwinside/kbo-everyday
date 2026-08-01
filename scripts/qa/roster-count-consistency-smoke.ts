/**
 * roster SSOT가 정상적으로 변해도 런타임 소스 재작성이나 고정 count 수정을
 * 요구하지 않는지 검증한다. 인원 급변은 크롤 workflow의 main 대비 delta+ack,
 * 현재 데이터 정합은 validate-roster의 shape/유일 ID/팀당 하한 계약이 담당한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const runtimeTargets = [
  "src/app/api/roster/route.ts",
  "src/app/api/health/roster/route.ts",
  "scripts/validate-roster.mjs",
];

let pass = 0;
for (const rel of runtimeTargets) {
  const source = read(rel);
  assert.doesNotMatch(source, /EXPECTED_(?:ROSTER_)?COUNT\s*=\s*\d+/,
    `${rel} must not require a source rewrite when roster count changes`);
  console.log(`✓ ${rel}: fixed roster count absent`);
  pass++;
}

const health = read("src/app/api/health/roster/route.ts");
assert.match(health, /duplicate kboId/);
assert.match(health, /MIN_PER_TEAM/);
console.log("✓ health route keeps shape/unique-id/team-min contracts");
pass++;

const validator = read("scripts/validate-roster.mjs");
assert.match(validator, /roster\.length === 0/);
assert.match(validator, /kboId duplicated/);
assert.match(validator, /MIN_PER_TEAM/);
console.log("✓ validator keeps non-empty/unique-id/team-min contracts");
pass++;

console.log(`\nPASS — roster dynamic count contract (${pass} pass)`);
