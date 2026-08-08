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
// ⚠︎ 워크플로 YAML 은 문자열이 아니라 **파싱해서** 본다 — step/job env 스코프 결손은
// 문자열 존재 검사로 안 잡힌다. 파서는 repo 에 이미 있는 js-yaml 을 쓴다.
import yaml from "js-yaml";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_PATH_ENV,
  EVIDENCE_SCHEMA,
  TRUST_DENY_REASONS,
  buildCompletionEvidence,
  decideRosterScopeTrust,
  parseProductionTeamIds,
  resolveExpectedSlotCount,
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

/* ⚠︎ 게이트도 기대 슬롯 수를 하드코딩하지 않는다 — 실제 production 정본에서 뽑는다.
 * 숫자를 여기 적으면 팀이 늘어난 날 게이트가 먼저 거짓 RED 를 낸다. */
const TEAMS_SOURCE = readFileSync("src/lib/constants/teams.ts", "utf8");
const PROD_SLOTS = resolveExpectedSlotCount(TEAMS_SOURCE);

const goodEvidence = {
  schema: EVIDENCE_SCHEMA,
  complete: true,
  summary: `완주 ${PROD_SLOTS}/${PROD_SLOTS} 슬롯`,
  expectedSlots: PROD_SLOTS,
  observedSlots: PROD_SLOTS,
  failures: 0,
  runId: "12345",
  runAttempt: "1",
};

const decide = (evidence, env = RUN_ENV, expectedSlotCount = PROD_SLOTS) =>
  decideRosterScopeTrust({
    evidenceRaw: evidence === null ? null : JSON.stringify(evidence),
    env,
    expectedSlotCount,
  });

console.log("\n▸ 정상 경로 — 이번 런이 완주했으면 통과한다");

check("★ 이번 런 + 전 슬롯 완주 → trusted", () => {
  const d = decide(goodEvidence);
  assert.equal(d.trusted, true, d.detail);
  assert.match(d.detail, new RegExp(`${PROD_SLOTS}\\/${PROD_SLOTS}`));
});

console.log("\n▸ ★ fail-close 축 — '판단 불가'는 전부 보류다");

check("★ 증거 없음 → 보류(배선이 끊어지면 종전 동작으로 돌아간다)", () => {
  const d = decideRosterScopeTrust({ evidenceRaw: null, env: RUN_ENV, expectedSlotCount: PROD_SLOTS });
  assert.equal(d.trusted, false);
  assert.equal(d.reason, TRUST_DENY_REASONS.EVIDENCE_MISSING);
});

check("빈 문자열도 증거가 아니다", () => {
  assert.equal(
    decideRosterScopeTrust({ evidenceRaw: "   ", env: RUN_ENV, expectedSlotCount: PROD_SLOTS }).reason,
    TRUST_DENY_REASONS.EVIDENCE_MISSING,
  );
});

check("파싱 불가 → 보류", () => {
  const d = decideRosterScopeTrust({ evidenceRaw: "{not json", env: RUN_ENV, expectedSlotCount: PROD_SLOTS });
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

console.log("\n▸ ★ 삼순 3차 ② — 증거가 자기 기대치를 실고 오는 순환을 막는다");

/* ⚠︎ 이게 없으면 크롤 대상 팀이 1팀으로 줄어도 "1팀 중 1팀 완주" 로 통과한다.
 * 9팀이 통째로 사라진 PR 이 자동머지되는 경로다. 소비자는 기대치를 정본에서 재구성한다. */
check("★ 크롤 대상이 줄어 기대치를 낮게 신고하면 보류(정본 대조)", () => {
  const shrunk = { ...goodEvidence, expectedSlots: 2, observedSlots: 2, summary: "완주 2/2 슬롯" };
  const d = decide(shrunk);
  assert.equal(d.reason, TRUST_DENY_REASONS.SLOT_MISMATCH);
  assert.match(d.detail, /production 정본과 다르다/);
});

check("★ 반대로 기대치를 높게 신고해도 보류(양방향)", () => {
  const inflated = { ...goodEvidence, expectedSlots: PROD_SLOTS + 2, observedSlots: PROD_SLOTS + 2 };
  assert.equal(decide(inflated).reason, TRUST_DENY_REASONS.SLOT_MISMATCH);
});

check("★ 정본을 해석하지 못하면 보류(모를 때 증거를 믿지 않는다)", () => {
  assert.equal(
    decide(goodEvidence, RUN_ENV, null).reason,
    TRUST_DENY_REASONS.SLOT_CONTRACT_UNRESOLVED,
  );
  assert.equal(
    decide(goodEvidence, RUN_ENV, 1).reason,
    TRUST_DENY_REASONS.SLOT_CONTRACT_UNRESOLVED,
  );
});

check("★ 정본 파서가 실제 teams.ts 에서 10팀을 뽑는다", () => {
  const ids = parseProductionTeamIds(TEAMS_SOURCE);
  assert.ok(Array.isArray(ids), "정본 파싱 실패");
  assert.equal(ids.length, 10, `KBO 10팀이어야 한다 — actual ${ids.length}`);
  assert.deepEqual([...ids].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

check("★ 정본이 깨지면 null(중복·미달을 통과시키지 않는다)", () => {
  assert.equal(parseProductionTeamIds("  id: 1,\n  id: 1,\n"), null, "중복 id");
  assert.equal(parseProductionTeamIds("  id: 1,\n"), null, "2팀 미달");
  assert.equal(parseProductionTeamIds(null), null);
});

console.log("\n▸ ★ 삼순 3차 ③ — 스키마 불일치는 fail-close");

check("★ 스키마가 다르면 보류(같은 필드를 다른 뜻으로 읽는다)", () => {
  const d = decide({ ...goodEvidence, schema: "roster-completion-evidence/2" });
  assert.equal(d.reason, TRUST_DENY_REASONS.SCHEMA_MISMATCH);
});

check("★ 스키마 필드 누락도 보류", () => {
  const { schema, ...noSchema } = goodEvidence;
  void schema;
  assert.equal(decide(noSchema).reason, TRUST_DENY_REASONS.SCHEMA_MISMATCH);
});

check("생성기가 현재 스키마를 붙인다(생산자·소비자 합의)", () => {
  const evidence = buildCompletionEvidence({
    completion: { complete: true, summary: "완주", failures: [], missingKeys: [] },
    expectedSlots: PROD_SLOTS,
    env: RUN_ENV,
  });
  assert.equal(evidence.schema, EVIDENCE_SCHEMA);
  assert.equal(decide(evidence).trusted, true);
});

check("★ 관측 슬롯이 기대보다 적으면 보류", () => {
  const d = decide({ ...goodEvidence, observedSlots: PROD_SLOTS - 1 });
  assert.equal(d.reason, TRUST_DENY_REASONS.SLOT_MISMATCH);
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
    decideRosterScopeTrust({ evidenceRaw: null, env: RUN_ENV, expectedSlotCount: PROD_SLOTS }).reason,
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

/* ⚠︎ 삼순 3차 ① — **producer 와 consumer 가 같은 경로를 봐야 한다.**
 *
 * 초안은 증거 경로를 `Crawl roster` **step 레벨** env 에 뒀다. 그러면 크롤은 증거를 쓰지만
 * 자동머지 판정 스텝에서는 env 가 비어 있어 언제나 `evidence_missing` 이 되고, 가드가
 * 영구 보류로 굳는다 — 즉 이 PR 이 아무것도 열지 못한다(삼순 실증, YAML 파싱으로 확인).
 * 그래서 job 레벨 env 하나를 SSOT 로 두고, 게이트는 **두 스텝이 같은 값을 본다**는 사실을
 * YAML 을 실제로 파싱해 확인한다(문자열 존재 검사로는 이 결손이 안 잡힌다). */
const workflowDoc = yaml.load(workflow);
const updateJob = workflowDoc?.jobs?.update;

const stepsOf = (job) => (Array.isArray(job?.steps) ? job.steps : []);
const findStep = (name) => stepsOf(updateJob).find((st) => String(st?.name ?? "").includes(name));

/** 그 스텝이 실제로 보는 증거 경로(step env 가 있으면 그것, 없으면 job env). */
const effectiveEvidencePath = (step) =>
  step?.env?.[EVIDENCE_PATH_ENV] ?? updateJob?.env?.[EVIDENCE_PATH_ENV] ?? null;

check("★ producer·consumer 가 **같은** 증거 경로를 본다(step 레벨 env 결손 차단)", () => {
  const producer = findStep("Crawl roster");
  const consumer = findStep("auto-merge");
  assert.ok(producer, "Crawl roster 스텝을 찾지 못했다");
  assert.ok(consumer, "자동머지 스텝을 찾지 못했다");

  const producerPath = effectiveEvidencePath(producer);
  const consumerPath = effectiveEvidencePath(consumer);
  assert.ok(producerPath, "producer 가 증거 경로를 못 본다 — 증거가 아예 안 쓰인다");
  assert.ok(
    consumerPath,
    "consumer 가 증거 경로를 못 본다 — 항상 evidence_missing 이 되어 가드가 영구 보류로 굳는다",
  );
  assert.equal(producerPath, consumerPath, "두 스텝이 다른 경로를 보면 증거가 전달되지 않는다");
});

check("★ 증거는 workspace 밖(runner.temp)에 쓴다 — allowlist·git diff 오염 금지", () => {
  const path = effectiveEvidencePath(findStep("Crawl roster"));
  assert.match(String(path), /runner\.temp/, "workspace 안에 쓰면 생성 데이터로 오인된다");
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

console.log("\n▸ ★ 의존성 선언 — hoist 우연에 기대지 않는다");

/* ⚠︎ 삼순 지적: 이 게이트가 `js-yaml` 을 직접 import 하는데 root package.json 에는
 * 선언이 없고 lock 에 **transitive**(eslint → @eslint/eslintrc)로만 있었다.
 * 지금은 hoist 덕에 우연히 해석되지만, 상위 패키지가 그 의존을 떼거나 버전을 올리면
 * clean install 에서 게이트가 **ERR_MODULE_NOT_FOUND 로 죽는다** — 계약이 사라지는 게 아니라
 * 검증이 사라지는 쪽이라 더 위험하다. 그래서 직접 import 하는 패키지는 direct dep 으로 박는다. */
check("★ 직접 import 하는 외부 패키지가 root package.json 에 선언돼 있다", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);

  const source = readFileSync("scripts/qa/roster-scope-trust-smoke.mjs", "utf8");
  const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
  // 상대경로·node: 빌트인은 선언 대상이 아니다.
  const bare = specifiers.filter((spec) => !spec.startsWith(".") && !spec.startsWith("node:"));
  assert.ok(bare.length > 0, "bare import 를 추출하지 못했다 — 추출식이 깨졌다");

  const undeclared = bare.filter((spec) => !declared.has(spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/")));
  assert.deepEqual(
    undeclared,
    [],
    `direct dependency 로 선언되지 않은 import — transitive hoist 에 기대면 clean install 에서 게이트가 죽는다: ${undeclared.join(", ")}`,
  );
});

check("★ lock 에도 root 직접 의존으로 박혀 있다(설치 재현성)", () => {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const rootDev = lock.packages?.[""]?.devDependencies ?? {};
  const rootProd = lock.packages?.[""]?.dependencies ?? {};
  assert.ok(
    rootDev["js-yaml"] || rootProd["js-yaml"],
    "lock 의 root 엔트리에 js-yaml 이 없다 — transitive 만으로는 재현되지 않는다",
  );
  assert.ok(lock.packages?.["node_modules/js-yaml"], "lock 에 js-yaml 설치 엔트리가 없다");
});

console.log(`\n✅ roster scope trust: ${passed} PASS`);
