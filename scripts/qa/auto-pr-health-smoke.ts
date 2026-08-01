/**
 * 자동 PR 파이프라인 감시 회귀 스모크 (2026-08-01 하린아빠 지시, #cs 1785572202.838849).
 * 실행: npx tsx scripts/qa/auto-pr-health-smoke.ts  (npm run qa:auto-pr-health)
 *
 * 배경 사건: 자동 크롤 run이 7/26·7/27 실패하고 auto PR #893(6일)·#699(2주)가 방치됐는데
 * 아무 알림도 없었다. 아래 계약이 깨지면 그 사고가 그대로 재발한다.
 *
 * 지키는 계약:
 *   ① run 실패를 잡는다.
 *   ② auto PR 적체를 잡는다 — **checks가 전부 성공이어도** 방치면 문제다(#699 실제 케이스).
 *   ③ 미실행(스케줄러 사망)을 잡는다 — run이 아예 없거나 주기 2배를 넘김.
 *   ④ 정상 상태에서는 알림을 만들지 않는다(오탐 0 — 알림 피로가 곧 무시로 이어진다).
 *   ⑤ 다른 워크플로의 PR을 자기 것으로 오인하지 않는다(브랜치 접두사 격리).
 *   ⑥ 최신 run 기준으로 판정한다(과거 실패가 복구 후에도 계속 울리지 않는다).
 */
import assert from "node:assert/strict";

import {
  AUTO_WORKFLOWS,
  PR_STALE_HOURS,
  evaluateAutoPrHealth,
  evaluateAutoWorkflow,
  formatAutoPrAlert,
  type AutoWorkflowDef,
  type OpenPrInfo,
  type WorkflowRunInfo,
} from "../../src/lib/admin/auto-pr-health";

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${String((e as Error).message).split("\n")[0]}`);
    failures.push(name);
  }
}

const NOW = Date.parse("2026-08-01T13:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const DEF: AutoWorkflowDef = {
  key: "roster-stats-auto-pr",
  label: "로스터/스탯 자동 PR",
  workflowFile: "update-roster-stats.yml",
  branchPrefix: "auto/update-roster-stats",
  intervalHours: 24,
};

const okRun: WorkflowRunInfo = {
  status: "completed",
  conclusion: "success",
  createdAt: hoursAgo(5),
  htmlUrl: null,
};

// ── ① run 실패 ───────────────────────────────────────────────────────────
check("① 최신 run이 failure면 잡는다", () => {
  const issue = evaluateAutoWorkflow(
    DEF,
    [{ status: "completed", conclusion: "failure", createdAt: hoursAgo(5), htmlUrl: "https://gh/run/1" }],
    [],
    NOW,
  );
  assert.ok(issue, "이상을 못 잡았다");
  assert.equal(issue.kind, "run-failed");
  assert.match(issue.reason, /failure/);
  assert.match(issue.reason, /https:\/\/gh\/run\/1/, "run 링크가 있어야 바로 확인 가능");
});

check("① cancelled/timed_out도 실패로 본다", () => {
  for (const conclusion of ["cancelled", "timed_out", "startup_failure"]) {
    const issue = evaluateAutoWorkflow(
      DEF,
      [{ status: "completed", conclusion, createdAt: hoursAgo(3) }],
      [],
      NOW,
    );
    assert.ok(issue, `${conclusion} 미감지`);
    assert.equal(issue.kind, "run-failed");
  }
});

// ── ⑥ 최신 기준 판정 ─────────────────────────────────────────────────────
check("⑥ 과거 실패 + 최신 성공이면 알리지 않는다(복구 후 무알림)", () => {
  const issue = evaluateAutoWorkflow(
    DEF,
    [
      { status: "completed", conclusion: "failure", createdAt: hoursAgo(30) },
      { status: "completed", conclusion: "success", createdAt: hoursAgo(5) },
    ],
    [],
    NOW,
  );
  assert.equal(issue, null, "복구됐는데 계속 알린다");
});

check("⑥ 진행 중 run은 완료 판정에서 제외한다", () => {
  const issue = evaluateAutoWorkflow(
    DEF,
    [
      { status: "in_progress", conclusion: null, createdAt: hoursAgo(1) },
      { status: "completed", conclusion: "success", createdAt: hoursAgo(5) },
    ],
    [],
    NOW,
  );
  assert.equal(issue, null);
});

// ── ② PR 적체 ────────────────────────────────────────────────────────────
const stalePr: OpenPrInfo = {
  number: 893,
  headRefName: "auto/update-roster-stats-20260726",
  createdAt: hoursAgo(6 * 24),
  checksPassing: false,
};

check("② 오래된 auto PR을 잡는다", () => {
  const issue = evaluateAutoWorkflow(DEF, [okRun], [stalePr], NOW);
  assert.ok(issue);
  assert.equal(issue.kind, "pr-stale");
  assert.match(issue.reason, /#893/);
});

check("② checks 전부 성공이어도 방치면 잡는다(#699 실제 케이스)", () => {
  const issue = evaluateAutoWorkflow(
    DEF,
    [okRun],
    [{
      number: 699,
      headRefName: "auto/update-roster-stats-20260718",
      createdAt: hoursAgo(14 * 24),
      checksPassing: true,
    }],
    NOW,
  );
  assert.ok(issue, "체크가 성공이라고 넘어가면 #699가 또 방치된다");
  assert.equal(issue.kind, "pr-stale");
  assert.match(issue.reason, /머지만 안 됨/);
});

check("② 임계 이내 PR은 정상으로 본다(방금 만든 PR에 알림 금지)", () => {
  const issue = evaluateAutoWorkflow(
    DEF,
    [okRun],
    [{
      number: 1050,
      headRefName: "auto/update-roster-stats-20260801",
      createdAt: hoursAgo(PR_STALE_HOURS - 1),
      checksPassing: null,
    }],
    NOW,
  );
  assert.equal(issue, null);
});

// ── ⑤ 접두사 격리 ────────────────────────────────────────────────────────
check("⑤ 다른 워크플로/사람이 만든 PR은 무시한다", () => {
  const issue = evaluateAutoWorkflow(
    DEF,
    [okRun],
    [
      { number: 1, headRefName: "auto/hero-shot-20260701", createdAt: hoursAgo(30 * 24), checksPassing: true },
      { number: 2, headRefName: "feat/whatever", createdAt: hoursAgo(30 * 24), checksPassing: true },
      { number: 3, headRefName: "fix/roster-count-gate", createdAt: hoursAgo(30 * 24), checksPassing: false },
    ],
    NOW,
  );
  assert.equal(issue, null, "남의 PR로 오탐이 났다");
});

// ── ③ 미실행 ─────────────────────────────────────────────────────────────
check("③ run 기록이 아예 없으면 잡는다", () => {
  const issue = evaluateAutoWorkflow(DEF, [], [], NOW);
  assert.ok(issue);
  assert.equal(issue.kind, "never-ran");
});

check("③ 주기 2배를 넘도록 실행이 없으면 잡는다(스케줄러 사망)", () => {
  const issue = evaluateAutoWorkflow(
    DEF,
    [{ status: "completed", conclusion: "success", createdAt: hoursAgo(49) }],
    [],
    NOW,
  );
  assert.ok(issue, "가장 조용한 실패를 놓쳤다");
  assert.equal(issue.kind, "never-ran");
  assert.match(issue.reason, /실행되지 않았습니다/);
});

check("③ 주기 안이면 미실행으로 보지 않는다", () => {
  const issue = evaluateAutoWorkflow(
    DEF,
    [{ status: "completed", conclusion: "success", createdAt: hoursAgo(25) }],
    [],
    NOW,
  );
  assert.equal(issue, null);
});

// ── ④ 정상 무알림 ────────────────────────────────────────────────────────
check("④ 정상 상태에서는 알림 0건", () => {
  const issues = evaluateAutoPrHealth(
    AUTO_WORKFLOWS,
    new Map(AUTO_WORKFLOWS.map((d) => [d.key, [okRun]])),
    [],
    NOW,
  );
  assert.deepEqual(issues, []);
});

check("④ 여러 워크플로 중 문제 있는 것만 보고한다", () => {
  const runs = new Map<string, WorkflowRunInfo[]>([
    ["roster-stats-auto-pr", [{ status: "completed", conclusion: "failure", createdAt: hoursAgo(2) }]],
    ["hero-shot-auto-pr", [okRun]],
  ]);
  const issues = evaluateAutoPrHealth(AUTO_WORKFLOWS, runs, [], NOW);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, "roster-stats-auto-pr");
});

// ── 알림 문구 ────────────────────────────────────────────────────────────
check("알림 문구에 종류·대상·사유가 모두 있다", () => {
  const msg = formatAutoPrAlert({
    key: "roster-stats-auto-pr",
    label: "로스터/스탯 자동 PR",
    kind: "run-failed",
    reason: "마지막 실행이 failure (2시간째)",
  });
  assert.match(msg, /자동 PR 실행 실패/);
  assert.match(msg, /로스터\/스탯 자동 PR/);
  assert.match(msg, /failure/);
});

// ── 실제 사고 재현 ───────────────────────────────────────────────────────
check("사고 재현: 7/26 run 실패 + #893/#699 적체 상황을 잡는다", () => {
  const issue = evaluateAutoWorkflow(
    DEF,
    [{ status: "completed", conclusion: "failure", createdAt: hoursAgo(6 * 24) }],
    [
      stalePr,
      { number: 699, headRefName: "auto/update-roster-stats-20260718", createdAt: hoursAgo(14 * 24), checksPassing: true },
    ],
    NOW,
  );
  assert.ok(issue, "그때 이 코드가 있었으면 즉시 알렸어야 한다");
  // run 실패가 더 직접적인 사유이므로 그것으로 보고된다(적체는 어드민 화면에서 확인).
  assert.equal(issue.kind, "run-failed");
});

console.log(
  `\n${failures.length === 0 ? "PASS" : "FAIL"} — auto PR health (${pass} pass, ${failures.length} fail)`,
);
process.exit(failures.length === 0 ? 0 : 1);
