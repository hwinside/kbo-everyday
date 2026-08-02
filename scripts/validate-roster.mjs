#!/usr/bin/env node
/**
 * Roster SSOT Validator (specs/roster-ssot-fortress.md v0.2 §3.1)
 *
 * CI 가드: src/lib/constants/players-roster.json에 대해 아래 규칙 전수 검사.
 * 하나라도 FAIL이면 exit 1, PR 머지 차단.
 *
 * 선수 수 변경 안전성은 자동 크롤 workflow의 main 대비 delta+ack 가드가 담당한다.
 * 이 validator는 현재 JSON 자체의 shape/유일성/팀별 하한을 검증한다.
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
// 형상 계약 (스펙 §3.1)
// ============================================================================
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
// Check 1: SSOT는 빈 배열이어선 안 된다. 정상 변동을 막는 고정 count는 두지 않는다.
// ============================================================================
if (roster.length === 0) fail("roster must not be empty");

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
// Check 5.7: 신규 외국인 숫자-id 온보딩 중 국적 미등록(A안) — warn만(비차단).
//   reconcile이 숨긴 건 foreign-nationality-pending.json에 쌓으며, 사람이 player-nationality.json에
//   국적을 넣으면 다음 reconcile 실행에 자동 소멸한다. FP/AQ 강제(5.6)와 달리 숫자 외인은
//   페이지·사진이 이미 정상이라 CI를 막지 않고 국기만 미표시(graceful) → warn으로만 가시화.
// ============================================================================
{
  const PENDING_PATH = path.resolve(__dirname, "../src/lib/constants/foreign-nationality-pending.json");
  let pending = {};
  try { pending = JSON.parse(fs.readFileSync(PENDING_PATH, "utf8")); } catch { /* 없으면 skip */ }
  let nationality = {};
  try { nationality = JSON.parse(fs.readFileSync(NATIONALITY_PATH, "utf8")); } catch { /* 5.6에서 이미 fail */ }
  for (const [kid, info] of Object.entries(pending)) {
    if (kid in nationality) continue; // 이미 국적 등록됨(다음 reconcile이 pending에서 제거)
    warn(
      `신규 외국인 국적 미등록: ${info?.name ?? "?"} (${kid}, ${info?.team ?? "?"}) — ` +
        `player-nationality.json에 "${kid}": "<ISO alpha-2>" 추가 시 국기 표시(페이지·사진은 이미 정상).`,
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
console.log(`  total=${roster.length}  contract=shape+unique-id+team-min`);
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
