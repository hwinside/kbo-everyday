/**
 * KBO LINEUP_CK 파서 순수 회귀 (라인업 확정 트리거).
 * 실행: npm run qa:lineup-ck
 */
import { parseLineupCk, fetchLineupConfirmed } from "../../src/lib/crawler/lineup-confirmed";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}

// game-detail 응답 형태: data[0] = [{ LINEUP_CK: true/false }]
ok("LINEUP_CK true → true", parseLineupCk([[{ LINEUP_CK: true }], [], [], [], []]) === true);
ok("LINEUP_CK false → false", parseLineupCk([[{ LINEUP_CK: false }], []]) === false);
ok("빈 배열 → null", parseLineupCk([]) === null);
ok("data[0] 빈 → null", parseLineupCk([[]]) === null);
ok("LINEUP_CK 키 없음 → null", parseLineupCk([[{ FOO: 1 }]]) === null);
ok("비배열 → null", parseLineupCk(null) === null);
ok("문자열 → null", parseLineupCk("x") === null);
ok("truthy 비-boolean(1) → true", parseLineupCk([[{ LINEUP_CK: 1 }]]) === true);
ok("falsy(0) → false", parseLineupCk([[{ LINEUP_CK: 0 }]]) === false);

// ── (삼순 #952 4차 blocker1) timeoutMs 는 srId 0/1 합산 절대 예산 — 2배 초과 금지 ──
async function budget() {
  const realFetch = globalThis.fetch;
  // fetch 를 자기 signal.abort 에서만 reject 하도록 mock(서버 응답 없음=느린 경기).
  // ⚠️ AbortSignal.timeout() 타이머는 Node 에서 unref 되어, 순수 promise mock 만 있으면
  //    이벤트루프가 abort 전에 비어 종료된다(실 fetch 는 refed 소켓으로 정상). refed keepAlive 로
  //    루프를 살려 abort 가 실제로 발생하게 한다.
  const keepAlive = setInterval(() => {}, 5);
  let calls = 0;
  globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) => {
    calls++;
    return new Promise((_resolve, reject) => {
      const sig = init?.signal;
      if (!sig) return;
      if (sig.aborted) return reject(new Error("aborted"));
      sig.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as typeof fetch;
  try {
    const BUDGET = 40;
    const t0 = Date.now();
    const ck = await fetchLineupConfirmed("20260729LGWO0", { timeoutMs: BUDGET });
    const elapsed = Date.now() - t0;
    ok("전건 abort → null(신호 못 얻음)", ck === null);
    // 구 코드(srId 마다 40ms) 면 calls=2·~80ms. 신 코드는 예산 공유라 srId0 소진 후
    // srId1 은 remaining≤0 으로 break → calls=1·~40ms. calls===1 이 절대 예산 준수의 마커.
    ok(`전체 소요 ≤ 2배 미만(${elapsed}ms < 70ms)`, elapsed < 70);
    ok(`srId 예산 공유 — srId0 소진 후 srId1 즉시 break(calls=${calls}===1)`, calls === 1);
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = realFetch;
  }
}

async function run() {
  await budget();
  console.log(`\nlineup-ck 파서: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
run();
