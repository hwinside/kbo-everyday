#!/usr/bin/env node
/**
 * `②-b roster_scope` 가드가 **완주 증거에 결속**돼 있는지 검증한다.
 *
 * ⚠︎ 이 게이트가 지켜야 하는 것은 "가드가 열렸다"가 아니라 **어떤 조건에서 열리는가**다.
 * 가드를 삭제하면 자동머지가 항상 열리고, 그 상태도 "roster PR 이 머지된다"는 관찰로는
 * 구분되지 않는다. 그래서 판정 함수를 **직접 호출**해 fail-close 축을 하나씩 태우고,
 * 워크플로·크롤러 배선이 실제로 살아 있는지도 함께 본다.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_PATH_ENV,
  TRUST_DENY_REASONS,
  buildCompletionEvidence,
  decideRosterScopeTrust,
} from "../lib/roster-scope-trust.mjs";

let passed = 0;
const check = (label, fn) => {
  const outcome = fn();
  if (outcome instanceof Promise) throw new Error(`async check 는 await 되지 않는다: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
};

const WORKFLOW = ".github/workflows/update-roster-stats.yml";
const CRAWLER = "scripts/crawl-roster-v2.mjs";
const CI_SCRIPT = "scripts/ci/assert-roster-scope-trust.mjs";

const RUN_ENV = { GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "1" };
const goodEvidence = {
  schema: "roster-completion-evidence/1",
  complete: true,
  summary: "완주 20/20 슬롯",
  expectedSlots: 20,
  observedSlots: 20,
  failures: 0,
  runId: "12345",
  runAttempt: "1",
};
const decide = (evidence, env = RUN_ENV) =>
  decideRosterScopeTrust({
    evidenceRaw: evidence === null ? null : JSON.stringify(evidence),
    env,
  });

console.log("\n▸ 정상 경로 — 이번 런이 완주했으면 통과한다");

check("★ 이번 런 + 전 슬롯 완주 → trusted", () => {
  const d = decide(goodEvidence);
  assert.equal(d.trusted, true, d.detail);
  assert.match(d.detail, /20\/20/);
});

console.log("\n▸ ★ fail-close 축 — '판단 불가'는 전부 보류다");

check("★ 증거 없음 → 보류(배선이 끊어지면 종전 동작으로 돌아간다)", () => {
  const d = decideRosterScopeTrust({ evidenceRaw: null, env: RUN_ENV });
  assert.equal(d.trusted, false);
  assert.equal(d.reason, TRUST_DENY_REASONS.EVIDENCE_MISSING);
});

check("빈 문자열도 증거가 아니다", () => {
  assert.equal(
    decideRosterScopeTrust({ evidenceRaw: "   ", env: RUN_ENV }).reason,
    TRUST_DENY_REASONS.EVIDENCE_MISSING,
  );
});

check("파싱 불가 → 보류", () => {
  const d = decideRosterScopeTrust({ evidenceRaw: "{not json", env: RUN_ENV });
  assert.equal(d.reason, TRUST_DENY_REASONS.EVIDENCE_UNPARSABLE);
});

check("★ 다른 런의 증거 → 보류(직전 런 증거로 이번 부분수집이 통과하면 안 된다)", () => {
  const d = decide(goodEvidence, { GITHUB_RUN_ID: "99999", GITHUB_RUN_ATTEMPT: "1" });
  assert.equal(d.reason, TRUST_DENY_REASONS.EVIDENCE_STALE);
});

check("★ 같은 run 이라도 attempt 가 다르면 보류(재실행분 증거 재사용 차단)", () => {
  const d = decide(goodEvidence, { GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "2" });
  assert.equal(d.reason, TRUST_DENY_REASONS.EVIDENCE_STALE);
});

check("현재 런 식별자를 모르면 보류", () => {
  assert.equal(decide(goodEvidence, {}).reason, TRUST_DENY_REASONS.EVIDENCE_STALE);
});

check("★ 미완주(complete=false) → 보류", () => {
  const d = decide({ ...goodEvidence, complete: false, summary: "미완주 — 실패 1건" });
  assert.equal(d.reason, TRUST_DENY_REASONS.CRAWL_INCOMPLETE);
  assert.match(d.detail, /미완주/);
});

check("complete 가 truthy 문자열이어도 통과하지 않는다(=== true 만)", () => {
  assert.equal(decide({ ...goodEvidence, complete: "true" }).reason, TRUST_DENY_REASONS.CRAWL_INCOMPLETE);
});

check("★ expectedSlots=0 → 보류('0개 중 0개 완주'로 계약이 비어버린다)", () => {
  const d = decide({ ...goodEvidence, expectedSlots: 0, observedSlots: 0 });
  assert.equal(d.reason, TRUST_DENY_REASONS.SLOT_MISMATCH);
});

check("★ 슬롯 수 불일치 → 보류(19/20)", () => {
  const d = decide({ ...goodEvidence, observedSlots: 19 });
  assert.equal(d.reason, TRUST_DENY_REASONS.SLOT_MISMATCH);
  assert.match(d.detail, /19\/20/);
});

check("★ complete=true 인데 팀 실패가 남아 있으면 보류(플래그만 믿지 않는다)", () => {
  const d = decide({ ...goodEvidence, failures: 1 });
  assert.equal(d.reason, TRUST_DENY_REASONS.CRAWL_INCOMPLETE);
});

console.log("\n▸ ★ 증거 생성 — 크롤러가 만드는 payload 가 계약을 만족하는가");

check("★ buildCompletionEvidence 출력이 그대로 trusted 가 된다(왕복)", () => {
  const evidence = buildCompletionEvidence({
    completion: { complete: true, summary: "완주 20/20 슬롯", failures: [], missingKeys: [] },
    expectedSlots: 20,
    env: RUN_ENV,
  });
  assert.equal(decide(evidence).trusted, true);
});

/* ⚠︎ 자체발견: 초안은 "크롤러가 완주 판정 **이후**에만 증거를 쓴다"를 소스 문자열
 * 순서(indexOf 비교)로 봤다. 그 검사는 상수 이름만 바꾸어도 무력해지고, 실제로는
 * 상수 *값*을 크롤러 소스에서 찾으려다 자기가 먼저 거짓 RED 를 냈다(크롤러엔 식별자만 있으니).
 * 순서로 지키려는 방향 자체가 허점이다 — 생산 지점에서 **만들 수 없게** 바꿔
 * 행동으로 통제한다. 리팩터가 호출을 위로 올려도 그자리에서 던진다. */
check("★ 미완주 상태로는 증거 자체를 만들 수 없다(호출 순서에 의지하지 않는다)", () => {
  assert.throws(
    () => buildCompletionEvidence({
      completion: { complete: false, summary: "미완주 — 실패 1건", failures: [{}], missingKeys: ["bat|1"] },
      expectedSlots: 20,
      env: RUN_ENV,
    }),
    /roster_completion_evidence_refused/,
  );
});

check("★ completion 이 없어도 거부한다(인자 누락이 백지수해가 되면 안 된다)", () => {
  assert.throws(() => buildCompletionEvidence({ expectedSlots: 20, env: RUN_ENV }), /refused/);
});

check("★ 증거가 쓰이지 않은 상황은 결국 보류로 이어진다(생성 거부 → evidence_missing)", () => {
  assert.equal(
    decideRosterScopeTrust({ evidenceRaw: null, env: RUN_ENV }).reason,
    TRUST_DENY_REASONS.EVIDENCE_MISSING,
  );
});

console.log("\n▸ ★ CI 스크립트 행동 — exit code 로 게이트를 움직인다");

/* ⚠︎ 여기부터는 소스 문자열이 아니라 **실제 프로세스**를 돌린다.
 * "판정 함수는 옳지만 CI 스크립트가 그 결과를 무시" 하는 형태가 문자열 검사로는 안 잡힌다. */
const runCi = (env) => {
  try {
    execFileSync(process.execPath, [CI_SCRIPT], { env: { ...process.env, ...env }, stdio: "pipe" });
    return 0;
  } catch (error) {
    return error.status ?? -1;
  }
};

const dir = mkdtempSync(join(tmpdir(), "roster-scope-trust-"));
const evidenceFile = join(dir, "evidence.json");
writeFileSync(evidenceFile, JSON.stringify(goodEvidence));

check("★ 정상 증거 → exit 0", () => {
  assert.equal(runCi({ ...RUN_ENV, [EVIDENCE_PATH_ENV]: evidenceFile }), 0);
});

check("★ env 미설정 → exit 1(배선 끊김이 개방이 되면 안 된다)", () => {
  const env = { ...RUN_ENV };
  delete env[EVIDENCE_PATH_ENV];
  assert.equal(runCi({ ...env, [EVIDENCE_PATH_ENV]: "" }), 1);
});

check("★ 파일 부재 → exit 1", () => {
  assert.equal(runCi({ ...RUN_ENV, [EVIDENCE_PATH_ENV]: join(dir, "nope.json") }), 1);
});

check("★ 다른 런 증거 → exit 1", () => {
  assert.equal(
    runCi({ GITHUB_RUN_ID: "777", GITHUB_RUN_ATTEMPT: "1", [EVIDENCE_PATH_ENV]: evidenceFile }),
    1,
  );
});

console.log("\n▸ 결속(배선이 실제로 살아 있는가)");

const workflow = readFileSync(WORKFLOW, "utf8");
const crawler = readFileSync(CRAWLER, "utf8");

check("★ 크롤 스텝이 증거 경로 env 를 주입한다", () => {
  const step = workflow.match(/- name: Crawl roster\n([\s\S]*?)\n {6}- name:/);
  assert.ok(step, "Crawl roster 스텝을 찾지 못했다");
  assert.match(step[1], new RegExp(`${EVIDENCE_PATH_ENV}:`), "env 주입이 끊어졌다");
});

check("★ 증거는 workspace 밖(runner.temp)에 쓴다 — allowlist·git diff 오염 금지", () => {
  const step = workflow.match(/- name: Crawl roster\n([\s\S]*?)\n {6}- name:/);
  assert.match(step[1], /runner\.temp/, "workspace 안에 쓰면 생성 데이터로 오인된다");
});

check("★ 크롤러가 증거를 **공용 생성기로만** 만든다(직접 조립 금지)", () => {
  assert.match(crawler, /buildCompletionEvidence\(/, "생성기 호출이 끊어졌다");
  // 생성기를 안 거치고 payload 를 직접 적으면 미완주 거부가 우회된다.
  assert.doesNotMatch(
    crawler,
    /roster-completion-evidence\//,
    "증거 payload 를 크롤러에서 조립하면 생성기의 fail-close 를 우회한다",
  );
});

check("★ 자동머지 단계가 판정 스크립트를 실제로 실행한다", () => {
  assert.match(
    workflow,
    new RegExp(`node ${CI_SCRIPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    "판정을 셸 조건으로 되돌리면 게이트가 행동을 검증할 수 없다",
  );
});

/* ⚠︎ 자체발견: 첫 정규식은 `roster_scope_changed` 첫 등장부터 잡아서 **감지 블록**을
 * 물었다(가드 블록이 아니다). 감지와 판정은 다른 스텝이라, 앵커를 자동머지 스텝의
 * 조건문 자체로 고정한다. 블록을 잘못 잡는 게이트는 대상이 죽어도 GREEN 이다. */
check("★ 판정 실패가 exit 1 로 이어진다(보류 경로 보존)", () => {
  const gate = workflow.match(
    /if \[ "\$\{\{ steps\.changes\.outputs\.roster_scope_changed \}\}" = "true" \]; then([\s\S]*?)\n {10}fi\n/,
  );
  assert.ok(gate, "②-b 자동머지 가드 블록을 찾지 못했다");
  assert.match(gate[1], /if ! node scripts\/ci\/assert-roster-scope-trust\.mjs/);
  assert.match(gate[1], /exit 1/, "판정 실패가 통과로 흐르면 가드가 없는 것과 같다");
});

check("★ roster 범위 감지 자체는 그대로 남아 있다(감지를 지우면 판정할 대상이 없다)", () => {
  assert.match(workflow, /ROSTER_SCOPE_RE=/);
  assert.match(workflow, /roster_scope_changed=true/);
});

/* ⚠︎ 자체발견: 첫 판은 `/MAX_DELTA=10/` 였는데 그건 `MAX_DELTA=100000` 에도 매칭된다
 * (실측: 급변 가드를 사실상 무력화하는 변이가 GREEN 이었다). 완화가 이 PR 의 방향이라
 * 다른 안전망이 조용히 풀리는 건 특히 위험하다 — 값을 **경계까지** 고정한다. */
check("★ 급변 가드 임계가 값까지 고정된다(완화가 다른 안전망으로 번지지 않는다)", () => {
  const m = workflow.match(/^\s*MAX_DELTA=(\d+)\s*$/m);
  assert.ok(m, "MAX_DELTA 선언을 찾지 못했다");
  assert.equal(m[1], "10", `급변 가드 임계가 바뀌었다 — actual ${m[1]}`);
});

check("allowlist 가드는 그대로 남아 있다", () => {
  assert.match(workflow, /off_allowlist/);
});

console.log(`\n✅ roster scope trust: ${passed} PASS`);
