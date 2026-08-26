/**
 * 게이트: relay 퍼블리셔 상태전이 결함주입 (⑦⑧축) — 삼순 조건부 GO(22:32) 2건 중 1건.
 *
 * durable-ordering DB 계약(RPC)은 relay-ordering-fault-injection.mts(①~⑥, 실 PG)가 검증한다.
 * 이 게이트는 그 위의 JS 레벨 상태전이를 mock deps 로 검증한다 — **PostgREST/PG 불필요**라
 * CI 에서 안전하게 돈다.
 *
 *  ⑦ 결과별 state 전이: insertFrame 이 `stale`/`lock_busy` 를 반환하면 `lastHash[channel]` 과
 *     `publishedFull` 은 **불변**이어야 한다. 갱신되면 해시가 실제 커밋보다 앞서가서 다음 tick 이
 *     "무변경"으로 판정 → **영구 미발행 데드락**. inserted 일 때만 갱신되는 계약을 못박는다.
 *  ⑧ superseded(abort) 인보케이션 fanout 0: signal 이 abort 된 tick 은 insertFrame(=RPC 발행/
 *     realtime fanout)을 **한 번도** 호출하지 않는다. 늦게 깨어난 A tick 이 B 뒤에 프레임을 꽂아
 *     역전시키는 것을 publishGameTick 레벨에서 차단(비용/정합 양쪽) — 이 PR 비용 모델(fanout)의 실증.
 *     (주: handler 는 tasks eager 생성이라 abort 여도 호출된다. superseded 인보케이션의 upstream
 *      재fetch 0 은 route 의 inFlight overlap-skip 이 publishGameTick 자체를 안 부르는 것으로 보장 —
 *      아래 ⑧-c 에서 소스 구조로 확인.)
 *
 * env 불필요. 실패 시 exit 1.
 */
import { readFileSync } from "node:fs";
import {
  publishGameTick,
  newGameState,
  type TickDeps,
  type RelayInsertOutcome,
  type PersistedGameState,
} from "../../src/lib/game/relay-live-publisher.ts";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) { pass += 1; console.log(`ok - ${name}${detail ? ` (${JSON.stringify(detail)})` : ""}`); }
  else { fail += 1; console.error(`FAIL - ${name} :: ${JSON.stringify(detail)}`); }
}

/** relay 채널 full 응답을 흉내내는 mock handler 응답. tick 마다 내용이 바뀌도록 seq 를 싣는다. */
function relayResponse(marker: number): Response {
  return new Response(
    JSON.stringify({ innings: [{ inning: 1, marker }], updatedAt: marker }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

interface Spy { handlerCalls: number; insertCalls: number; }

function makeDeps(
  outcome: RelayInsertOutcome,
  marker: number,
  spy: Spy,
): TickDeps {
  const handler = (): Promise<Response> => { spy.handlerCalls += 1; return Promise.resolve(relayResponse(marker)); };
  return {
    handlers: { relay: handler, events: handler, live: handler, detail: handler },
    insertFrame: (): Promise<RelayInsertOutcome> => { spy.insertCalls += 1; return Promise.resolve(outcome); },
    epoch: 1,
    date: "2026-08-26",
  };
}

async function run() {
  // ── ⑦-a stale 반환 → lastHash/publishedFull 불변 ──────────────────────────────
  {
    const state: PersistedGameState = newGameState();
    const spy: Spy = { handlerCalls: 0, insertCalls: 0 };
    const r = await publishGameTick(makeDeps("stale", 100, spy), state, "g1", 1, undefined);
    check("⑦-a stale: inserted 0 / stale 1", r.inserted === 0 && r.stale === 1, { inserted: r.inserted, stale: r.stale });
    check("⑦-a stale: lastHash[relay] 불변(미갱신)", state.lastHash.relay === undefined, state.lastHash);
    check("⑦-a stale: publishedFull false 유지", state.publishedFull === false, state.publishedFull);
    check("⑦-a stale: insertFrame 1회 호출됨(발행 시도는 함)", spy.insertCalls === 1, spy.insertCalls);
  }

  // ── ⑦-b lock_busy 반환 → lastHash/publishedFull 불변 ──────────────────────────
  {
    const state: PersistedGameState = newGameState();
    const spy: Spy = { handlerCalls: 0, insertCalls: 0 };
    const r = await publishGameTick(makeDeps("lock_busy", 200, spy), state, "g1", 1, undefined);
    check("⑦-b lock_busy: inserted 0 / lockBusy 1", r.inserted === 0 && r.lockBusy === 1, { inserted: r.inserted, lockBusy: r.lockBusy });
    check("⑦-b lock_busy: lastHash[relay] 불변(미갱신)", state.lastHash.relay === undefined, state.lastHash);
    check("⑦-b lock_busy: publishedFull false 유지", state.publishedFull === false, state.publishedFull);
  }

  // ── ⑦-c inserted 반환 → lastHash 갱신 + publishedFull true (대조군, 계약 양방향) ──
  {
    const state: PersistedGameState = newGameState();
    const spy: Spy = { handlerCalls: 0, insertCalls: 0 };
    const r = await publishGameTick(makeDeps("inserted", 300, spy), state, "g1", 1, undefined);
    check("⑦-c inserted: inserted 1", r.inserted === 1, r.inserted);
    check("⑦-c inserted: lastHash[relay] 갱신됨", typeof state.lastHash.relay === "string" && state.lastHash.relay.length === 64, state.lastHash.relay);
    check("⑦-c inserted: publishedFull true (relay-full 최초)", state.publishedFull === true, state.publishedFull);
  }

  // ── ⑦-d inserted 후 동일 내용 재tick → skippedUnchanged, insertFrame 미호출 ──────
  {
    const state: PersistedGameState = newGameState();
    const spy: Spy = { handlerCalls: 0, insertCalls: 0 };
    await publishGameTick(makeDeps("inserted", 400, spy), state, "g1", 1, undefined);
    const insertsAfterFirst = spy.insertCalls;
    const r2 = await publishGameTick(makeDeps("inserted", 400, spy), state, "g1", 1, undefined);
    check("⑦-d 동일내용 재tick: skippedUnchanged 1", r2.skippedUnchanged === 1, r2.skippedUnchanged);
    check("⑦-d 동일내용 재tick: insertFrame 추가호출 0(무변경 발행 안함)", spy.insertCalls === insertsAfterFirst, { after1: insertsAfterFirst, after2: spy.insertCalls });
  }

  // ── ⑧-a superseded(abort) 인보케이션 → insertFrame(fanout) 0 ────────────────────
  {
    const state: PersistedGameState = newGameState();
    const spy: Spy = { handlerCalls: 0, insertCalls: 0 };
    const ac = new AbortController();
    ac.abort(); // 이미 superseded — timeout/lock-lost 로 abort 된 tick 을 흉내
    const r = await publishGameTick(makeDeps("inserted", 500, spy), state, "g1", 1, ac.signal);
    check("⑧-a abort tick: insertFrame(fanout) 0회", spy.insertCalls === 0, spy.insertCalls);
    check("⑧-a abort tick: inserted 0", r.inserted === 0, r.inserted);
    check("⑧-a abort tick: lastHash/publishedFull 불변", state.lastHash.relay === undefined && state.publishedFull === false, state);
  }

  // ── ⑧-b abort 중간 발생 → 이후 채널 insertFrame 0 (다채널 tick) ─────────────────
  {
    const state: PersistedGameState = newGameState();
    const spy: Spy = { handlerCalls: 0, insertCalls: 0 };
    const ac = new AbortController();
    // tick 0 은 4채널(relay/events/live/detail). insertFrame 첫 호출 시 abort 를 트리거.
    let fired = false;
    const deps: TickDeps = {
      handlers: {
        relay: () => { spy.handlerCalls += 1; return Promise.resolve(relayResponse(600)); },
        events: () => { spy.handlerCalls += 1; return Promise.resolve(relayResponse(601)); },
        live: () => { spy.handlerCalls += 1; return Promise.resolve(relayResponse(602)); },
        detail: () => { spy.handlerCalls += 1; return Promise.resolve(relayResponse(603)); },
      },
      insertFrame: () => {
        spy.insertCalls += 1;
        if (!fired) { fired = true; ac.abort(); } // 첫 발행 직후 abort → 나머지 채널은 fence
        return Promise.resolve<RelayInsertOutcome>("inserted");
      },
      epoch: 1,
      date: "2026-08-26",
    };
    const r = await publishGameTick(deps, state, "g1", 0, ac.signal);
    // 첫 채널만 insertFrame 도달, 이후 채널은 abort fence 로 insertFrame 미도달.
    check("⑧-b abort 중간: insertFrame 1회만(이후 채널 fence)", spy.insertCalls === 1, spy.insertCalls);
    check("⑧-b abort 중간: aborted 에러로 나머지 채널 표기", r.errors.some((e) => e.includes("aborted")), r.errors);
  }

  // ── ⑧-c superseded 인보케이션 upstream 재fetch 0 = route inFlight overlap-skip (소스 구조 확인) ──
  {
    const routeSrc = readFileSync(
      new URL("../../src/app/api/cron/relay-live-publisher/route.ts", import.meta.url),
      "utf8",
    );
    // inFlight.has(gameId) 이면 publishGameTick 을 부르지 않고 overlap-skip 을 즉시 반환 =
    // 겹친(superseded) 인보케이션은 upstream handler 를 한 번도 안 부른다(재fetch 0).
    const hasOverlapGuard = /if\s*\(\s*inFlight\.has\(\s*gameId\s*\)\s*\)/.test(routeSrc);
    const skipReturnsBeforeTick = /overlap-skip/.test(routeSrc)
      && routeSrc.indexOf("overlap-skip") < routeSrc.indexOf("publishGameTick(deps");
    check("⑧-c route: inFlight overlap-skip 가드 존재", hasOverlapGuard, hasOverlapGuard);
    check("⑧-c route: overlap-skip 이 publishGameTick 앞단에서 return(재fetch 0)", skipReturnsBeforeTick, skipReturnsBeforeTick);
  }

  console.log(`\nRESULT ${fail === 0 ? "PASS" : "FAIL"} — ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
