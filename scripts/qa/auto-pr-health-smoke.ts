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
// route 모듈은 supabase/admin 싱글톤을 트랜지티브로 로드하고, 그 싱글톤이 모듈 로드
// 시점에 env 를 요구한다. DI 로 실제 DB 를 쓰지 않으므로 더미 값을 선주입한다.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

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
      // 임계(30분) 이내 + 체크 미상 = 아직 정상. 음수 나이(미래)로 도망가지 않게 절반값을 쓴다.
      createdAt: hoursAgo(PR_STALE_HOURS / 2),
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
  // run 실패와 PR 적체를 함께 보존해야 같은 실패 run 아래 새 PR이 생겨도 다시 알린다.
  assert.equal(issue.kind, "run-failed");
  assert.match(issue.reason, /#893/);
  assert.match(issue.reason, /#699/);
  assert.match(issue.fingerprint, /run:/);
  assert.match(issue.fingerprint, /pr:/);
});


// ── route-level 결속 (삼순 R1 P1) ─────────────────────────────────────────
// 순수 evaluator 만 호출하면 route 의 상태·발송 코드를 통째로 지워도 PASS 한다(false-green).
// 실제 runAutoPrWatch 를 DI 로 태워 claim/발송/revert/재알림을 검증한다.
async function runRouteLevelChecks() {

  const { runAutoPrWatch } = await import("../../src/app/api/cron/admin-alerts/route");

  const NOW_ISO = new Date(NOW).toISOString();
  const failedRun = (id: number) => ({
    id, status: "completed", conclusion: "failure",
    created_at: new Date(NOW - 3600_000).toISOString(),
    html_url: `https://github.com/x/y/actions/runs/${id}`,
  });

  /**
   * admin_alert_state 를 흉내내는 최소 인메모리 DB (CAS 의미 포함).
   *
   * ⚠️ 반드시 **thenable** 이어야 한다. route 는 revert 경로에서 `.select()` 없이
   * `await db.from().delete().eq().eq()` 로 바로 await 한다. select 안에서만 변경을
   * 적용하면 revert 가 아무 일도 안 하고, 구현이 멀쩡한데 "상태가 남아 있다"로 보인다
   * (내 첫 mock 이 실제로 그랬다).
   */
  function makeDb(initial: Record<string, string> = {}) {
    const rows = new Map<string, { job_name: string; level: string }>();
    for (const [k, v] of Object.entries(initial)) rows.set(k, { job_name: k, level: v });

    const api = {
      rows,
      from() {
        let job: string | null = null;
        let lvl: string | null = null;
        let op: "update" | "delete" | null = null;
        let pending: { level: string } | null = null;

        // CAS 적용: 대상 행의 level 이 기대값과 같을 때만 변경한다.
        const apply = (): { data: { job_name: string }[]; error: null } => {
          if (op === null || job === null) return { data: [], error: null };
          const hit = rows.get(job)?.level === lvl;
          if (hit && op === "update" && pending) rows.set(job, { job_name: job, level: pending.level });
          if (hit && op === "delete") rows.delete(job);
          op = null;
          return { data: hit ? [{ job_name: job }] : [], error: null };
        };

        const self: Record<string, unknown> = {
          select: () => {
            if (op === null) return { in: async () => ({ data: [...rows.values()], error: null }) };
            return Promise.resolve(apply());
          },
          in: async () => ({ data: [...rows.values()], error: null }),
          upsert: (row: { job_name: string; level: string }) => {
            const exists = rows.has(row.job_name);
            if (!exists) rows.set(row.job_name, { job_name: row.job_name, level: row.level });
            return { select: async () => ({ data: exists ? [] : [{ job_name: row.job_name }], error: null }) };
          },
          update: (row: { level?: string }) => { op = "update"; pending = { level: row.level as string }; return self; },
          delete: () => { op = "delete"; return self; },
          eq: (col: string, val: string) => {
            if (col === "job_name") job = val;
            if (col === "level") lvl = val;
            return self;
          },
          // select 없이 await 하는 경로(revert)를 위한 thenable
          then: (resolve: (v: unknown) => unknown) => resolve(apply()),
        };
        return self;
      },
    };
    return api;
  }

  // 감시 대상이 2개(로스터·히어로샷)라 모든 워크플로에 같은 실패 run 을 주면
  // claimed 가 2 로 나와 기대값 1 과 어긋난다. 로스터만 시나리오 run 을 쓴다.
  const okRunPayload = {
    id: 9, status: "completed", conclusion: "success",
    created_at: new Date(NOW - 3600_000).toISOString(), html_url: null,
  };
  const ghWith = (runs: unknown[], prs: unknown[] = []) => async (path: string) => {
    // 대상 워크플로(로스터)만 주어진 runs 를 쓰고, 나머지는 정상 run 으로 고정한다.
    if (path.includes("/actions/workflows/update-roster-stats.yml/")) return { workflow_runs: runs };
    if (path.includes("/actions/workflows/")) return { workflow_runs: [okRunPayload] };
    if (path.startsWith("/pulls")) return prs;
    if (path.includes("/check-runs")) return { check_runs: [] };
    return {};
  };

  // ① 전달 전패면 상태를 되돌려 다음 tick 에 재시도한다 (영구 누락 금지)
  {
    const db = makeDb();
    const res = await runAutoPrWatch(NOW_ISO, {
      token: "t",
      db: db as never,
      fetchGitHub: ghWith([failedRun(1)]),
      push: async () => ({ sent: 0, failed: 1 }),
      telegram: async () => ({ sent: 0, failed: 1 }),
    });
    check("route: 전달 전패면 claim 을 revert 한다", () => {
      assert.equal(res.sent, 0);
      assert.equal(res.reverted, 1, "revert 되지 않으면 다음 tick 이 skip 해 영구 누락된다");
      assert.equal(db.rows.has("roster-stats-auto-pr"), false, "revert 후에도 상태가 남아 있다");
    });
  }

  // ② 동시 2실행 — CAS 승자만 발송
  {
    const db = makeDb();
    // ⚠️ claimed 로 세면 안 된다 — "최초 healthy 상태 기록"도 claim 을 잡고 발송 전에 continue 한다
    //    (히어로샷이 healthy 로 초기화되며 +1). 계약은 **실제 발송 횟수**다.
    let pushCalls = 0;
    const opts = {
      token: "t",
      db: db as never,
      fetchGitHub: ghWith([failedRun(1)]),
      push: async () => { pushCalls++; return { sent: 1, failed: 0 }; },
      telegram: async () => ({ sent: 1, failed: 0 }),
    };
    await Promise.all([
      runAutoPrWatch(NOW_ISO, opts as never),
      runAutoPrWatch(NOW_ISO, opts as never),
    ]);
    check("route: 동시 2실행이어도 발송은 1회", () => {
      assert.equal(pushCalls, 1, `실제 발송 ${pushCalls}회 (기대 1) — CAS 가 중복 알림을 못 막았다`);
    });
  }

  // ③ 새 run 실패는 다시 알린다 (kind dedupe 였으면 무알림)
  {
    const db = makeDb();
    const titles: string[] = [];
    const base = {
      token: "t",
      db: db as never,
      push: async (p: { body?: string }) => { titles.push(p.body ?? ""); return { sent: 1, failed: 0 }; },
      telegram: async () => ({ sent: 1, failed: 0 }),
    };
    await runAutoPrWatch(NOW_ISO, { ...base, fetchGitHub: ghWith([failedRun(111)]) } as never);
    const afterFirst = titles.length;
    await runAutoPrWatch(NOW_ISO, { ...base, fetchGitHub: ghWith([failedRun(111)]) } as never);
    const afterSame = titles.length;
    await runAutoPrWatch(NOW_ISO, { ...base, fetchGitHub: ghWith([failedRun(222)]) } as never);
    const afterNext = titles.length;
    check("route: 같은 run 은 1회, 새 run 실패는 다시 알린다", () => {
      assert.equal(afterFirst, 1, `첫 실패를 알리지 않았다 (발송 ${afterFirst}회)`);
      assert.equal(afterSame, 1, `같은 run 을 중복 알림했다 (발송 ${afterSame}회)`);
      assert.equal(afterNext, 2, `다음 실패 run 을 놓쳤다 — kind dedupe 회귀 (발송 ${afterNext}회)`);
    });
  }

  // ④ 최초 healthy 는 상태만 기록하고 가짜 복구 알림을 보내지 않는다
  {
    const db = makeDb();
    let pushed = 0;
    const res = await runAutoPrWatch(NOW_ISO, {
      token: "t",
      db: db as never,
      fetchGitHub: ghWith([okRunPayload]),
      push: async () => { pushed++; return { sent: 1, failed: 0 }; },
      telegram: async () => ({ sent: 1, failed: 0 }),
    } as never);
    check("route: 최초 healthy 는 복구 알림을 보내지 않는다", () => {
      assert.equal(pushed, 0, `신규 key healthy 에 가짜 복구 알림이 나갔다(${res.sent}건)`);
      assert.equal(db.rows.get("roster-stats-auto-pr")?.level, "healthy", "상태는 기록돼야 한다");
    });
  }

  // ⑤ GitHub 조회 실패는 조용히 200 이 되면 안 된다
  {
    const db = makeDb();
    let threw = false;
    try {
      await runAutoPrWatch(NOW_ISO, {
        token: "t",
        db: db as never,
        fetchGitHub: async () => { throw new Error("GitHub /pulls HTTP 500"); },
        push: async () => ({ sent: 1, failed: 0 }),
        telegram: async () => ({ sent: 1, failed: 0 }),
      } as never);
    } catch { threw = true; }
    check("route: GitHub 조회 실패는 감춰지지 않는다(상위에서 5xx 로 노출)", () => {
      assert.equal(threw, true, "감시기 실패가 조용히 성공으로 끝났다");
    });
  }

  // ⑥ 같은 실패 run 아래 새 check-fail/적체 PR이 생기면 새 event로 다시 알린다
  {
    const db = makeDb();
    let pushed = 0;
    const base = {
      token: "t",
      db: db as never,
      push: async () => { pushed++; return { sent: 1, failed: 0 }; },
      telegram: async () => ({ sent: 1, failed: 0 }),
    };
    const problemPr = {
      number: 893,
      head: { ref: "auto/update-roster-stats-20260801", sha: "deadbeef" },
      html_url: "https://github.com/x/y/pull/893",
      created_at: new Date(NOW - 3600_000).toISOString(),
    };
    await runAutoPrWatch(NOW_ISO, { ...base, fetchGitHub: ghWith([failedRun(77)]) } as never);
    const afterRun = pushed;
    await runAutoPrWatch(NOW_ISO, {
      ...base,
      fetchGitHub: ghWith([failedRun(77)], [problemPr]),
    } as never);
    check("route: 같은 실패 run 아래 새 문제 PR도 다시 알린다", () => {
      assert.equal(afterRun, 1);
      assert.equal(pushed, 2, "run-failed 조기 return이 새 PR event를 가렸다");
      assert.match(db.rows.get("roster-stats-auto-pr")?.level ?? "", /pr:893/);
    });
  }

  // ⑦ GITHUB_PAT 누락과 check-runs 조회 실패는 상위 5xx로 올릴 수 있게 throw한다
  {
    let missingTokenThrew = false;
    try {
      await runAutoPrWatch(NOW_ISO, { token: null, db: makeDb() as never });
    } catch { missingTokenThrew = true; }

    const problemPr = {
      number: 893,
      head: { ref: "auto/update-roster-stats-20260801", sha: "deadbeef" },
      html_url: "https://github.com/x/y/pull/893",
      created_at: new Date(NOW - 600_000).toISOString(),
    };
    let checkLookupThrew = false;
    try {
      await runAutoPrWatch(NOW_ISO, {
        token: "t",
        db: makeDb() as never,
        fetchGitHub: async (path: string) => {
          if (path.includes("/actions/workflows/update-roster-stats.yml/")) return { workflow_runs: [okRunPayload] };
          if (path.includes("/actions/workflows/")) return { workflow_runs: [okRunPayload] };
          if (path.startsWith("/pulls")) return [problemPr];
          if (path.includes("/check-runs")) throw new Error("GitHub check-runs HTTP 500");
          return {};
        },
      } as never);
    } catch { checkLookupThrew = true; }
    check("route: token/check-runs 감시 실패는 성공으로 둔갑하지 않는다", () => {
      assert.equal(missingTokenThrew, true, "GITHUB_PAT 누락이 정상 반환됐다");
      assert.equal(checkLookupThrew, true, "check-runs 실패가 healthy/null로 삼켜졌다");
    });
  }
}

runRouteLevelChecks().then(() => {
  console.log(
    `\n${failures.length === 0 ? "PASS" : "FAIL"} — auto PR health (${pass} pass, ${failures.length} fail)`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}).catch((e) => {
  console.error("SMOKE ERROR:", (e as Error).message);
  process.exit(1);
});
