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
import { EVIDENCE_PATH_ENV, decideRosterScopeTrust } from "../lib/roster-scope-trust.mjs";

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

const decision = decideRosterScopeTrust({ evidenceRaw });

if (decision.trusted) {
  console.log(`✅ roster 범위 자동머지 허용 — ${decision.detail}`);
  process.exit(0);
}

console.error(`❌ roster 범위 자동머지 보류 [${decision.reason}] — ${decision.detail}`);
process.exit(1);
