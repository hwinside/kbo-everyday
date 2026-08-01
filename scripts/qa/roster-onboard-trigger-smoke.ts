/**
 * 온보딩 자동 트리거 회귀 스모크 (2026-08-01 P0, #cs 1785572202.838849).
 * 실행: npx tsx scripts/qa/roster-onboard-trigger-smoke.ts  (npm run qa:roster-onboard-trigger)
 *
 * 지키는 계약:
 *   ① roster SSOT 미등록 신규 등록 선수가 없으면 dispatch 하지 않는다.
 *   ② 진행 중(queued/in_progress 등) run이 있으면 dispatch 하지 않는다 — 자동 PR 난립 차단.
 *   ③ 최근 run이 쿨다운(30분) 안이면 dispatch 하지 않는다 — 30분 tick마다 같은 선수를 다시 보므로
 *      이 가드가 실질적 dedupe다.
 *   ④ 조건이 맞으면 정확히 1회 dispatch 하고, 대상 목록을 보고한다.
 *   ⑤ GitHub 목록 조회 실패 시 dispatch 하지 않는다(dedupe 판정 불가 → 지연이 난립보다 안전).
 *   ⑥ 토큰 없으면 no-token, dispatch 시도 0회.
 *   ⑦ 어떤 실패에서도 throw 하지 않는다(cron 본체 판정 불변).
 */
import assert from "node:assert/strict";

import {
  decideOnboardDispatch,
  triggerRosterOnboarding,
  MIN_DISPATCH_INTERVAL_MS,
  type WorkflowRunSummary,
} from "../../src/lib/roster-moves/onboard-trigger";

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✓ ${name}`);
      pass++;
    })
    .catch((e: Error) => {
      console.error(`✗ ${name}\n  ${e.message.split("\n")[0]}`);
      failures.push(name);
    });
}

const NOW = Date.parse("2026-08-01T12:00:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

/** dispatch/list 호출을 기록하는 fetch 스텁. */
function makeFetchStub(opts: {
  runs?: WorkflowRunSummary[];
  listStatus?: number;
  listThrows?: boolean;
  dispatchStatus?: number;
  dispatchThrows?: boolean;
}) {
  const calls: { kind: "list" | "dispatch"; url: string }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const isDispatch = url.endsWith("/dispatches");
    calls.push({ kind: isDispatch ? "dispatch" : "list", url });
    if (isDispatch) {
      if (opts.dispatchThrows) throw new Error("network");
      assert.equal(init?.method, "POST");
      return new Response(null, { status: opts.dispatchStatus ?? 204 });
    }
    if (opts.listThrows) throw new Error("network");
    if ((opts.listStatus ?? 200) !== 200) {
      return new Response("{}", { status: opts.listStatus ?? 500 });
    }
    return new Response(JSON.stringify({ workflow_runs: opts.runs ?? [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const baseDeps = (fetchImpl: typeof fetch, token = "tok") => ({
  fetchImpl,
  token,
  now: () => NOW,
});

async function main() {
  await check("① 신규 미등록 선수 0명이면 dispatch 안 함", async () => {
    const stub = makeFetchStub({});
    const res = await triggerRosterOnboarding([], baseDeps(stub.impl));
    assert.equal(res.status, "no-new-players");
    assert.equal(stub.calls.length, 0, "HTTP 호출 자체가 없어야 한다");
  });

  await check("② 진행 중 run이 있으면 dispatch 안 함", async () => {
    for (const status of ["queued", "in_progress", "requested", "waiting", "pending"]) {
      const stub = makeFetchStub({ runs: [{ status, created_at: iso(-3 * 60 * 60 * 1000) }] });
      const res = await triggerRosterOnboarding(["56103"], baseDeps(stub.impl));
      assert.equal(res.status, "run-in-flight", `status=${status}`);
      assert.equal(stub.calls.filter((c) => c.kind === "dispatch").length, 0);
    }
  });

  await check("③ 쿨다운(30분) 안이면 dispatch 안 함", async () => {
    const stub = makeFetchStub({
      runs: [{ status: "completed", created_at: iso(-(MIN_DISPATCH_INTERVAL_MS - 60_000)) }],
    });
    const res = await triggerRosterOnboarding(["56103"], baseDeps(stub.impl));
    assert.equal(res.status, "cooldown");
    assert.equal(stub.calls.filter((c) => c.kind === "dispatch").length, 0);
  });

  await check("③ 쿨다운 경계 직후면 dispatch 한다", async () => {
    const stub = makeFetchStub({
      runs: [{ status: "completed", created_at: iso(-(MIN_DISPATCH_INTERVAL_MS + 1000)) }],
    });
    const res = await triggerRosterOnboarding(["56103"], baseDeps(stub.impl));
    assert.equal(res.status, "dispatched");
  });

  await check("③ 미래 타임스탬프(시계 skew)는 방금 시작한 것으로 취급", () => {
    const decision = decideOnboardDispatch(
      ["56103"],
      [{ status: "completed", created_at: iso(+60_000) }],
      NOW,
    );
    assert.equal(decision.dispatch, false);
    assert.equal(decision.dispatch === false ? decision.reason : "", "cooldown");
  });

  await check("③ 여러 run 중 가장 최근 것 기준으로 판정", () => {
    const decision = decideOnboardDispatch(
      ["56103"],
      [
        { status: "completed", created_at: iso(-10 * 60 * 60 * 1000) },
        { status: "completed", created_at: iso(-60_000) }, // 최근 — 이게 이겨야 함
        { status: "completed", created_at: iso(-5 * 60 * 60 * 1000) },
      ],
      NOW,
    );
    assert.equal(decision.dispatch, false, "가장 최근 run이 쿨다운 안이면 막아야 한다");
  });

  await check("④ 조건 충족 시 정확히 1회 dispatch + 대상 보고", async () => {
    const stub = makeFetchStub({ runs: [] });
    const res = await triggerRosterOnboarding(["56103", "55435", "56103"], baseDeps(stub.impl));
    assert.equal(res.status, "dispatched");
    assert.deepEqual(res.players, ["55435", "56103"], "중복 제거 + 정렬");
    const dispatches = stub.calls.filter((c) => c.kind === "dispatch");
    assert.equal(dispatches.length, 1, "dispatch는 정확히 1회");
    assert.match(dispatches[0].url, /update-roster-stats\.yml\/dispatches$/);
  });

  await check("⑤ 목록 조회 실패면 dispatch 안 함(fail-safe)", async () => {
    for (const opts of [{ listStatus: 500 }, { listThrows: true }]) {
      const stub = makeFetchStub(opts);
      const res = await triggerRosterOnboarding(["56103"], baseDeps(stub.impl));
      assert.equal(res.status, "list-error");
      assert.equal(stub.calls.filter((c) => c.kind === "dispatch").length, 0);
    }
  });

  await check("⑥ 토큰 없으면 no-token, HTTP 0회", async () => {
    const stub = makeFetchStub({ runs: [] });
    const res = await triggerRosterOnboarding(["56103"], baseDeps(stub.impl, ""));
    assert.equal(res.status, "no-token");
    assert.equal(stub.calls.length, 0);
  });

  await check("⑦ dispatch 실패해도 throw 하지 않는다", async () => {
    for (const opts of [{ runs: [], dispatchStatus: 403 }, { runs: [], dispatchThrows: true }]) {
      const stub = makeFetchStub(opts);
      const res = await triggerRosterOnboarding(["56103"], baseDeps(stub.impl));
      assert.equal(res.status, "dispatch-error");
    }
  });

  // 사고 재현 대조: 카라스코 시나리오(미등록 1명 + 최근 run 없음) → dispatch 되어야 한다.
  await check("실제 시나리오: 카라스코 56103 감지 → dispatch", () => {
    const decision = decideOnboardDispatch(["56103"], [], NOW);
    assert.equal(decision.dispatch, true);
    assert.deepEqual(decision.dispatch === true ? decision.players : [], ["56103"]);
  });
}

await_main();

function await_main() {
  main().then(() => {
    console.log(
      `\n${failures.length === 0 ? "PASS" : "FAIL"} — roster onboard trigger (${pass} pass, ${failures.length} fail)`,
    );
    process.exit(failures.length === 0 ? 0 : 1);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
