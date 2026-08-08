#!/usr/bin/env node
/**
 * `②-b roster_scope` 가드 판정 — 이번 런의 roster 완주 증거가 있으면 exit 0, 없으면 exit 1.
 *
 * 워크플로 셸에 조건을 흩뿌리지 않는 이유: 셸 `if` 는 게이트가 행동으로 검증할 수 없고,
 * 다음 변경에서 조건 하나가 빠져도 조용히 통과한다. 판정은 순수 함수가 하고
 * 이 파일은 파일 읽기와 exit code 만 담당한다.
 *
 * ⚠︎ 읽기 실패도 보류다. "증거를 읽을 수 없다"를 통과로 취급하면 배선이 끊어진 상태가
 * 곧 자동머지 개방이 된다.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_PATH_ENV,
  decideRosterScopeTrust,
  resolveExpectedSlotCount,
} from "../lib/roster-scope-trust.mjs";

/* ── production 정본에서 기대 슬롯 수를 **독립으로** 계산한다 ──────────────
 *
 * 증거가 자기 기대치를 실고 오면 순환이다 — 크롤 대상 팀이 1팀으로 줄어도
 * "1팀 중 1팀 완주"가 되어 9팀이 사라진 PR 이 자동머지된다(삼순 지적 ②).
 * 읽지 못하면 통과가 아니라 보류다. */
const HERE = dirname(fileURLToPath(import.meta.url));
const TEAMS_SOURCE_PATH = join(HERE, "..", "..", "src", "lib", "constants", "teams.ts");

let expectedSlotCount = null;
try {
  expectedSlotCount = resolveExpectedSlotCount(readFileSync(TEAMS_SOURCE_PATH, "utf8"));
} catch (error) {
  console.error(`   production 팀 정본을 읽지 못했다 — ${TEAMS_SOURCE_PATH}: ${error?.message ?? error}`);
}

const path = process.env[EVIDENCE_PATH_ENV];

let evidenceRaw = null;
if (path) {
  try {
    evidenceRaw = readFileSync(path, "utf8");
  } catch (error) {
    console.error(`   증거 파일을 읽지 못했다 — ${path}: ${error?.message ?? error}`);
  }
} else {
  console.error(`   ${EVIDENCE_PATH_ENV} 가 설정되지 않았다 — 크롤 스텝의 env 배선을 확인하라`);
}

const decision = decideRosterScopeTrust({ evidenceRaw, expectedSlotCount });

if (decision.trusted) {
  console.log(`✅ roster 범위 자동머지 허용 — ${decision.detail}`);
  process.exit(0);
}

console.error(`❌ roster 범위 자동머지 보류 [${decision.reason}] — ${decision.detail}`);
process.exit(1);
