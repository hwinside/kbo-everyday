#!/usr/bin/env node
/**
 * Roster SSOT Validator (specs/roster-ssot-fortress.md v0.2 §3.1)
 *
 * CI 가드: src/lib/constants/players-roster.json에 대해 아래 규칙 전수 검사.
 * 하나라도 FAIL이면 exit 1, PR 머지 차단.
 *
 * 예외 허용:
 *  - 선수 수 변경은 PR body/commit msg에 "roster-size-change" 라벨 포함 시 허용.
 *  - 환경변수 ROSTER_SIZE_CHANGE_ACK=1로도 동일 우회 (CI 외 로컬 검증용).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROSTER_PATH = path.resolve(__dirname, "../src/lib/constants/players-roster.json");
const FOREIGN_MAP_PATH = path.resolve(__dirname, "../src/lib/constants/foreign-id-map.ts");

// ============================================================================
// 기대값 (스펙 §3.1)
// ============================================================================
const EXPECTED_COUNT = 791;
const MIN_PER_TEAM = 30;
const BACKNO_REGEX = /^(\d{1,3}|-|\?)$/; // 숫자 1~3자리 | "-" | "?"
const KNOWN_TEAMS = new Set([
  "KIA", "두산", "롯데", "삼성", "SSG", "NC", "한화", "키움", "LG", "KT",
]);

const errors = [];
const warnings = [];

function fail(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

function loadForeignIdPairs() {
  const source = fs.readFileSync(FOREIGN_MAP_PATH, "utf8");
  return [...source.matchAll(/"(\d+)":\s*"((?:FP|AQ)\d+)"/g)].map((m) => ({
    numeric: m[1],
    alpha: m[2],
  }));
}

// ============================================================================
// Load
// ============================================================================
let roster;
try {
  roster = JSON.parse(fs.readFileSync(ROSTER_PATH, "utf8"));
} catch (e) {
  console.error(`❌ failed to read/parse roster: ${e.message}`);
  process.exit(1);
}

if (!Array.isArray(roster)) {
  console.error(`❌ roster must be an array`);
  process.exit(1);
}

// ============================================================================
// Check 1: 선수 수 = EXPECTED_COUNT (예외 허용 시 경고로 전환)
// ============================================================================
const sizeChangeAck =
  process.env.ROSTER_SIZE_CHANGE_ACK === "1" ||
  (process.env.PR_BODY || "").includes("roster-size-change") ||
  (process.env.COMMIT_MSG || "").includes("roster-size-change");

if (roster.length !== EXPECTED_COUNT) {
  if (sizeChangeAck) {
    warn(
      `roster count changed: ${roster.length} (expected ${EXPECTED_COUNT}) — acknowledged via roster-size-change`,
    );
  } else {
    fail(
      `roster count mismatch: got ${roster.length}, expected ${EXPECTED_COUNT}. ` +
        `If intentional, add "roster-size-change" to PR body or commit message.`,
    );
  }
}

// ============================================================================
// Check 2: core field null/empty
// Check 3: kboId dup / empty
// Check 4: backNo enum (^(\d{1,3}|-|\?)$)
// Check 5: name control chars (\n, \r, \t)
// ============================================================================
const kboIdSeen = new Map(); // kboId -> index

roster.forEach((p, i) => {
  const loc = `[#${i}] ${p?.name ?? "(no name)"} (kboId=${p?.kboId ?? "?"})`;

  // core fields
  if (!p.kboId || typeof p.kboId !== "string" && typeof p.kboId !== "number") {
    fail(`${loc}: kboId missing or invalid type`);
  } else {
    const kid = String(p.kboId);
    if (!kid.trim()) fail(`${loc}: kboId empty`);
    if (kboIdSeen.has(kid)) {
      fail(`${loc}: kboId duplicated (also at #${kboIdSeen.get(kid)})`);
    } else {
      kboIdSeen.set(kid, i);
    }
  }

  if (!p.name || typeof p.name !== "string" || !p.name.trim()) {
    fail(`${loc}: name missing/empty`);
  } else if (/[\n\r\t]/.test(p.name)) {
    fail(`${loc}: name contains control chars: ${JSON.stringify(p.name)}`);
  }

  if (!p.team || !KNOWN_TEAMS.has(p.team)) {
    fail(`${loc}: team invalid (${JSON.stringify(p.team)})`);
  }

  if (typeof p.teamId !== "number" || p.teamId < 1 || p.teamId > 10) {
    fail(`${loc}: teamId invalid (${p.teamId})`);
  }

  if (!p.position || typeof p.position !== "string" || !p.position.trim()) {
    fail(`${loc}: position missing/empty`);
  }

  // backNo enum check
  if (p.backNo === null || p.backNo === undefined || p.backNo === "") {
    fail(`${loc}: backNo is null/empty — must be "${BACKNO_REGEX}"`);
  } else if (typeof p.backNo !== "string" || !BACKNO_REGEX.test(p.backNo)) {
    fail(`${loc}: backNo invalid format: ${JSON.stringify(p.backNo)} (expected digits or "-" or "?")`);
  }
});

// ============================================================================
// Check 5.5: foreign numeric ID aliases must not be separate roster entries
// ============================================================================
for (const { numeric, alpha } of loadForeignIdPairs()) {
  const hasNumeric = kboIdSeen.has(numeric);
  const hasAlpha = kboIdSeen.has(alpha);

  if (!hasAlpha) {
    fail(`foreign alias ${numeric}->${alpha}: canonical alpha id is missing from roster`);
    continue;
  }

  if (hasNumeric) {
    fail(
      `foreign alias ${numeric}->${alpha}: both numeric and canonical ids exist in roster. ` +
        `Keep ${alpha} as UI canonical and preserve ${numeric} only as an alias.`,
    );
  }
}

// ============================================================================
// Check 6: team counts ≥ MIN_PER_TEAM
// ============================================================================
const byTeam = {};
for (const p of roster) {
  if (p.team) byTeam[p.team] = (byTeam[p.team] || 0) + 1;
}
for (const team of KNOWN_TEAMS) {
  const c = byTeam[team] || 0;
  if (c < MIN_PER_TEAM) {
    fail(`team ${team}: only ${c} players (min ${MIN_PER_TEAM})`);
  }
}

// Known teams 외 등장 시 경고
for (const t of Object.keys(byTeam)) {
  if (!KNOWN_TEAMS.has(t)) {
    fail(`unknown team "${t}" (count=${byTeam[t]})`);
  }
}

// ============================================================================
// Report
// ============================================================================
console.log("");
console.log(`Roster SSOT Validator — ${ROSTER_PATH}`);
console.log(`  total=${roster.length}  expected=${EXPECTED_COUNT}`);
console.log(`  teams=${Object.keys(byTeam).sort().map((t) => `${t}:${byTeam[t]}`).join(" ")}`);
console.log("");

if (warnings.length) {
  console.log(`⚠️  ${warnings.length} warning(s):`);
  warnings.forEach((w) => console.log(`   - ${w}`));
  console.log("");
}

if (errors.length) {
  console.log(`❌ ${errors.length} error(s):`);
  errors.forEach((e) => console.log(`   - ${e}`));
  console.log("");
  console.error(`FAIL — roster validation blocked.`);
  process.exit(1);
}

console.log(`✅ PASS — roster SSOT is clean.`);
