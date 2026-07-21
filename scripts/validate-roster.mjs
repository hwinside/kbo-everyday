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
const NATIONALITY_PATH = path.resolve(__dirname, "../src/lib/constants/player-nationality.json");
const NATIONALITY_TS_PATH = path.resolve(__dirname, "../src/lib/utils/player-nationality.ts");
const FLAGS_DIR = path.resolve(__dirname, "../public/flags");

// ============================================================================
// 기대값 (스펙 §3.1)
// ============================================================================
const EXPECTED_COUNT = 875; // 2026-07-21: 교야마 마사야(AQ008) stale 중복 항목 제거(실제 등록명 쿄야마/56548로 통합). 876: 07-20 Player/Search.aspx 전수 dry-run 미출전/퓨처스 33명 1회 백필.
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
// Check 5.6: 외국인·아시아쿼터(FP/AQ)는 국적 매핑 필수 (player-nationality.json)
//   새 외국인 선수 온보딩 시 국적 누락을 CI에서 원천 차단(#642 후속).
//   사용된 국가코드는 국기 SVG(public/flags)와 한글 국가명(COUNTRY_NAME_KO) 둘 다 있어야 함.
// ============================================================================
{
  let nationality = {};
  try {
    nationality = JSON.parse(fs.readFileSync(NATIONALITY_PATH, "utf8"));
  } catch (e) {
    fail(`player-nationality.json 읽기/파싱 실패: ${e.message}`);
  }

  // (1) FP/AQ 로스터 선수는 국적 매핑 필수 — 새 외국인 등장 시 CI 빨간불
  for (const [kid, i] of kboIdSeen) {
    if (!/^(FP|AQ)\d+$/.test(kid)) continue;
    if (!(kid in nationality)) {
      const p = roster[i];
      fail(
        `${p?.name ?? "?"} (${kid}): 외국인/AQ 선수인데 player-nationality.json에 국적이 없습니다. ` +
          `KBO/구단 공식 기준으로 "${kid}": "<ISO alpha-2>" 를 추가하세요.`,
      );
    }
  }

  // (2) 로스터에 없는 국적 키는 orphan 경고(방출/교체 후 정리 권장, 비차단)
  for (const kid of Object.keys(nationality)) {
    if (!kboIdSeen.has(kid)) {
      warn(`player-nationality.json의 ${kid}는 현재 로스터에 없습니다(orphan).`);
    }
  }

  // (3) 사용된 국가코드는 국기 SVG + 한글 국가명 둘 다 필수(깨진 국기/빈 라벨 차단)
  const flagCodes = new Set(
    fs.existsSync(FLAGS_DIR)
      ? fs.readdirSync(FLAGS_DIR).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4).toLowerCase())
      : [],
  );
  const nameKoCodes = new Set(
    [...fs.readFileSync(NATIONALITY_TS_PATH, "utf8").matchAll(/\b([A-Z]{2}):\s*"/g)].map((m) => m[1]),
  );
  for (const code of new Set(Object.values(nationality))) {
    const lc = String(code).toLowerCase();
    if (!flagCodes.has(lc)) {
      fail(`국가코드 ${code}: public/flags/${lc}.svg 국기 파일이 없습니다.`);
    }
    if (!nameKoCodes.has(code)) {
      fail(`국가코드 ${code}: player-nationality.ts COUNTRY_NAME_KO에 한글 국가명이 없습니다.`);
    }
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
