#!/usr/bin/env node
/**
 * roster SSOT 변경에 딸린 *파생 산출물*을 같은 커밋 안에서 재생성/동기화한다.
 *
 * 배경 (2026-08-01 P0, #cs 스레드 1785572202.838849):
 *   LG 카라스코(56103) 온보딩으로 roster 878→879가 되자 매일 새벽 자동 PR(#1042)이
 *   머지 불가가 됐다. 원인은 크롤이 아니라 *우리 게이트 쪽 하드코딩*이다.
 *     (a) scripts/qa/roster-count-consistency-smoke.ts — roster JSON length가 세 상수와
 *         전부 같아야 통과. 자동 PR은 roster JSON만 바꾸므로 항상 FAIL.
 *         (2026-07-28 #907도 사람이 상수 3곳을 손으로 올려서 넘어갔다 = 자동 경로는 그때부터 막혀 있었다.)
 *     (b) scripts/qa/baseball-qa-source-inventory-smoke.ts — `assert.equal(roster.length, 878)`
 *         하드코딩(2026-07-31 #1018). 여기에 더해 data/baseball-qa/source-inventory.json은
 *         roster에서 결정론적으로 생성되는데 자동 PR이 재생성하지 않아 deepEqual도 깨진다.
 *   결과: *로스터 인원이 1명이라도 바뀌면 매일 새벽 자동 PR이 사람 손 없이는 영구 머지 불가*.
 *   (콜업·트레이드마다 스탯/로스터 반영 정지 = 7월 반복 사고 패턴)
 *
 * 이 스크립트는 "roster JSON이 진실, 나머지는 파생"이라는 계약을 코드로 강제한다.
 * 파생 대상:
 *   1) src/app/api/roster/route.ts        EXPECTED_ROSTER_COUNT
 *   2) src/app/api/health/roster/route.ts EXPECTED_ROSTER_COUNT
 *   3) scripts/validate-roster.mjs        EXPECTED_COUNT
 *   4) data/baseball-qa/source-inventory.json + seed SQL (build:baseball-source-inventory 위임)
 *
 * 안전 경계 — 이 스크립트가 하지 않는 것:
 *   - roster JSON 자체를 고치지 않는다(진실을 건드리지 않음).
 *   - 크롤 오류 판정을 하지 않는다. 인원 급변 방어는 워크플로의 `roster-size-change` ack와
 *     Δ>MAX_DELTA 급변 가드, validate-roster / validate-player-identity / foreign-photo가 계속 맡는다.
 *   - 상수 치환은 `const <NAME> = <숫자>` 한 토큰만 정규식으로 바꾼다(그 외 코드 무변경).
 *
 * Usage:
 *   node scripts/ci/sync-roster-derived-artifacts.mjs          # 동기화 수행(파일 씀)
 *   node scripts/ci/sync-roster-derived-artifacts.mjs --check  # 검사만, drift면 exit 1 (파일 무변경)
 *
 * --check는 상수 3곳만 본다. inventory JSON/seed의 결정론적 일치는 기존
 * qa:baseball-source-inventory의 `assert.deepEqual(rebuilt, inventory)`가 이미 게이트한다
 * (중복 검사로 prebuild를 느리게 만들지 않는다).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const checkOnly = process.argv.includes("--check");

const ROSTER_PATH = path.join(ROOT, "src/lib/constants/players-roster.json");

/** 파생 상수 3곳: [상대경로, 상수 이름] */
const CONSTANT_TARGETS = [
  ["src/app/api/roster/route.ts", "EXPECTED_ROSTER_COUNT"],
  ["src/app/api/health/roster/route.ts", "EXPECTED_ROSTER_COUNT"],
  ["scripts/validate-roster.mjs", "EXPECTED_COUNT"],
];

const roster = JSON.parse(fs.readFileSync(ROSTER_PATH, "utf8"));
if (!Array.isArray(roster) || roster.length === 0) {
  console.error("❌ roster SSOT가 배열이 아니거나 비어 있음 — 파생 동기화 중단(fail-close)");
  process.exit(1);
}
const rosterCount = roster.length;

const drift = [];

for (const [relPath, constName] of CONSTANT_TARGETS) {
  const absPath = path.join(ROOT, relPath);
  const src = fs.readFileSync(absPath, "utf8");
  const re = new RegExp(`(const\\s+${constName}\\s*=\\s*)(\\d+)`);
  const m = src.match(re);
  if (!m) {
    console.error(`❌ ${relPath}: \`const ${constName} = <숫자>\` 를 찾지 못함 — 계약 파손(fail-close)`);
    process.exit(1);
  }
  const current = Number(m[2]);
  if (current === rosterCount) continue;

  drift.push(`${relPath}: ${constName} ${current} → ${rosterCount}`);
  if (!checkOnly) {
    fs.writeFileSync(absPath, src.replace(re, `$1${rosterCount}`));
  }
}

if (checkOnly) {
  if (drift.length === 0) {
    console.log(`✅ roster 파생 상수 동기화 상태 (roster ${rosterCount}명)`);
    process.exit(0);
  }
  console.error(`❌ roster 파생 상수 drift (roster ${rosterCount}명)`);
  for (const line of drift) console.error(`   • ${line}`);
  console.error("   → node scripts/ci/sync-roster-derived-artifacts.mjs 로 동기화하세요.");
  process.exit(1);
}

// source inventory(+seed SQL)는 roster에서 결정론적으로 생성되므로 생성기에 위임한다.
execFileSync("npx", ["tsx", "scripts/baseball-qa/build-source-inventory.ts"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "inherit"],
});
drift.push("data/baseball-qa/source-inventory.json + seed SQL: 생성기 재실행");

console.log(`🔧 roster 파생 산출물 동기화 완료 (roster ${rosterCount}명)`);
for (const line of drift) console.log(`   • ${line}`);
