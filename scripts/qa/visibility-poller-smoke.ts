/**
 * visibility-aware 폴링 스케줄러 스모크.
 * 실시간 손실 0(보이면 즉시+주기 폴링, 복귀 즉시 갱신) + 안 보는 탭 폴링 0을 회귀로 고정한다.
 *
 * poller의 tick은 async(콜백 완료 후 다음 예약)이므로, 각 조작 뒤 마이크로태스크를
 * flush해 tick 연속(스케줄/재개)을 결정론적으로 소진한다.
 *
 * 실행: npx tsx scripts/qa/visibility-poller-smoke.ts
 */
import { startVisibilityPoller } from "../../src/lib/polling/visibility-poller";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${name}`); }
}

/** 실제 매크로태스크 한 틱 → 대기 중 마이크로태스크 전부 소진(가짜 타이머는 별도). */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** 결정론적 가짜 타이머 + visibility 하네스. */
function makeHarness(startHidden = false) {
  let hidden = startHidden;
  let now = 0;
  let seq = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let visHandler: (() => void) | null = null;
  let calls = 0;

  const deps = {
    isHidden: () => hidden,
    onVisibilityChange: (h: () => void) => { visHandler = h; return () => { visHandler = null; }; },
    schedule: (fn: () => void, ms: number) => { const id = seq++; timers.set(id, { at: now + ms, fn }); return id; },
    cancel: (id: number) => { timers.delete(id); },
    now: () => now,
    callback: () => { calls++; },
    intervalMs: 1000,
  };

  return {
    deps,
    get calls() { return calls; },
    /** 시간을 ms만큼 진행하며 만기 타이머를 순서대로 실행. 각 실행 뒤 마이크로태스크 flush. */
    async advance(ms: number) {
      const target = now + ms;
      let guard = 0;
      while (guard++ < 10000) {
        let nextId: number | null = null;
        let nextAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < nextAt) { nextAt = t.at; nextId = id; }
        }
        if (nextId === null) break;
        const t = timers.get(nextId)!;
        timers.delete(nextId);
        now = t.at;
        t.fn();
        await flush(); // tick의 async 연속(다음 예약) 소진
      }
      now = target;
    },
    async setHidden(v: boolean) { hidden = v; if (visHandler) visHandler(); await flush(); },
    pendingTimers() { return timers.size; },
  };
}

async function run() {
  // 1) 초기 visible: 즉시 1회 + 주기 폴링.
  {
    const h = makeHarness(false);
    const stop = startVisibilityPoller(h.deps);
    await flush();
    check("초기 visible → 즉시 1회 실행", h.calls === 1);
    await h.advance(1000);
    check("1초 후 2회", h.calls === 2);
    await h.advance(3000);
    check("추가 3초 후 5회(주기 폴링)", h.calls === 5);
    stop();
  }

  // 2) 초기 hidden: 실행 0, 타이머 예약 0.
  {
    const h = makeHarness(true);
    const stop = startVisibilityPoller(h.deps);
    await flush();
    check("초기 hidden → 실행 0", h.calls === 0);
    await h.advance(5000);
    check("hidden 5초 경과해도 실행 0(폴링 요청 0)", h.calls === 0);
    check("hidden 예약 타이머 0", h.pendingTimers() === 0);
    stop();
  }

  // 3) visible→hidden 전환: 폴링 정지.
  {
    const h = makeHarness(false);
    const stop = startVisibilityPoller(h.deps);
    await flush();
    await h.advance(1000);
    check("1초 후 2회", h.calls === 2);
    await h.setHidden(true);
    const before = h.calls;
    await h.advance(5000);
    check("hidden 전환 후 추가 실행 0", h.calls === before);
    check("hidden 전환 후 예약 타이머 0", h.pendingTimers() === 0);
    stop();
  }

  // 4) hidden→visible 복귀: 즉시 1회 + 폴링 재개.
  {
    const h = makeHarness(false);
    const stop = startVisibilityPoller(h.deps);
    await flush();
    await h.advance(1000); // calls=2
    await h.setHidden(true);
    await h.advance(5000); // 정지, calls=2
    const before = h.calls;
    await h.setHidden(false);
    check("visible 복귀 → 즉시 1회 갱신(실시간 손실 0)", h.calls === before + 1);
    await h.advance(1000);
    check("복귀 후 주기 폴링 재개", h.calls === before + 2);
    stop();
  }

  // 5) stop() 이후: 추가 실행 0, 리스너 해제.
  {
    const h = makeHarness(false);
    const stop = startVisibilityPoller(h.deps);
    await flush();
    await h.advance(2000);
    const before = h.calls;
    stop();
    await h.advance(5000);
    check("stop 후 추가 실행 0", h.calls === before);
    await h.setHidden(false);
    await h.setHidden(true);
    check("stop 후 visibility 이벤트 무시(핸들러 해제)", h.calls === before);
    check("stop 후 예약 타이머 0", h.pendingTimers() === 0);
  }

  // ── 비동기(느린 콜백) 경계: single-flight fence 회귀 ──
  // 삼순 P1: A pending 중 hidden→visible이 새 tick과 겹쳐 중복 Edge Request를 냈다.

  /** 콜백을 수동 resolve하는 deferred 하네스(동시 실행/겹침 추적). */
  function makeDeferredHarness(startHidden = false) {
    let hidden = startHidden;
    let now = 0;
    let seq = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let visHandler: (() => void) | null = null;
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const pending: Array<() => void> = []; // 각 콜백의 resolve

    const deps = {
      isHidden: () => hidden,
      onVisibilityChange: (h: () => void) => { visHandler = h; return () => { visHandler = null; }; },
      schedule: (fn: () => void, ms: number) => { const id = seq++; timers.set(id, { at: now + ms, fn }); return id; },
      cancel: (id: number) => { timers.delete(id); },
      now: () => now,
      callback: () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        return new Promise<void>((resolve) => {
          pending.push(() => { active--; resolve(); });
        });
      },
      intervalMs: 1000,
    };

    return {
      deps,
      get calls() { return calls; },
      get maxActive() { return maxActive; },
      get inFlight() { return active; },
      pendingCount() { return pending.length; },
      pendingTimers() { return timers.size; },
      /** 가장 오래된 in-flight 콜백 1개를 완료. */
      async settleOne() { const r = pending.shift(); if (r) r(); await flush(); },
      async setHidden(v: boolean) { hidden = v; if (visHandler) visHandler(); await flush(); },
      async advance(ms: number) {
        const target = now + ms;
        let guard = 0;
        while (guard++ < 10000) {
          let nextId: number | null = null;
          let nextAt = Infinity;
          for (const [id, t] of timers) {
            if (t.at <= target && t.at < nextAt) { nextAt = t.at; nextId = id; }
          }
          if (nextId === null) break;
          const t = timers.get(nextId)!;
          timers.delete(nextId);
          now = t.at;
          t.fn();
          await flush();
        }
        now = target;
      },
    };
  }

  // 6) A pending 중 hidden→visible: 겹침 없이 settle 후 정확히 1회 재실행.
  {
    const h = makeDeferredHarness(false);
    const stop = startVisibilityPoller(h.deps);
    await flush();
    check("deferred: 초기 콜백 1회 시작(in-flight)", h.calls === 1 && h.inFlight === 1);
    await h.setHidden(true);          // in-flight 중 숨김
    await h.setHidden(false);         // in-flight 중 복귀 → 큐잉만, 새 tick 시작 금지
    check("deferred: in-flight 중 복귀는 새 콜백을 시작하지 않음(겹침 0)", h.calls === 1 && h.maxActive === 1);
    await h.settleOne();              // A 완료 → 큐된 복귀 1회 즉시 재실행
    check("deferred: settle 후 정확히 1회 재실행", h.calls === 2);
    check("deferred: 동시 실행 최대 1(no-overlap 계약)", h.maxActive === 1);
    check("deferred: 재실행도 in-flight 1건뿐", h.inFlight === 1);
    await h.settleOne();              // 재실행 완료 → 주기 타이머 예약
    check("deferred: settle 후 예약 타이머 ≤ 1", h.pendingTimers() === 1);
    stop();
  }

  // 7) A pending 중 hidden→visible 여러 번: 재실행은 여전히 1회(정확히 once).
  {
    const h = makeDeferredHarness(false);
    const stop = startVisibilityPoller(h.deps);
    await flush();
    await h.setHidden(true); await h.setHidden(false);
    await h.setHidden(true); await h.setHidden(false);
    await h.setHidden(true); await h.setHidden(false);
    check("deferred: 복귀 여러 번이어도 in-flight 중 겹침 0", h.calls === 1 && h.maxActive === 1);
    await h.settleOne();
    check("deferred: 복귀 여러 번이어도 재실행은 정확히 1회", h.calls === 2 && h.maxActive === 1);
    stop();
  }

  // 8) 느린 콜백 중 interval 타이머 발화: 겹치지 않음.
  {
    const h = makeDeferredHarness(false);
    const stop = startVisibilityPoller(h.deps);
    await flush();
    await h.settleOne();          // 첫 콜백 완료 → 1000ms 타이머 예약
    await h.advance(1000);        // 타이머 발화 → 두번째 콜백 시작(in-flight)
    check("deferred: interval 발화로 2번째 시작", h.calls === 2 && h.inFlight === 1);
    await h.advance(3000);        // 진행 중엔 새 타이머 없음 → 추가 발화 겹침 없음
    check("deferred: in-flight 동안 추가 겹침 0", h.maxActive === 1);
    stop();
  }

  // 9) stop() during pending: 후행 예약·재실행 차단.
  {
    const h = makeDeferredHarness(false);
    const stop = startVisibilityPoller(h.deps);
    await flush();
    check("deferred: stop 전 in-flight 1", h.inFlight === 1);
    stop();                        // pending 중 정리
    await h.settleOne();           // A resolve
    check("deferred: stop 후 재실행 0(후행 tick 차단)", h.calls === 1);
    check("deferred: stop 후 예약 타이머 0", h.pendingTimers() === 0);
    await h.setHidden(false);
    check("deferred: stop 후 visibility 무시", h.calls === 1);
  }

  // ── anchored cadence: 콜백 duration이 0이 아니어도 start-to-start ≈ interval ──
  // 삼순 P1(재정정): 기존 setInterval은 시작기준 30주기였는데, 콜백 완료 후
  // interval을 재면 start간격이 interval + 요청지연이 되어 활성 탭 신선도가 drift한다.
  function makeTimedHarness(callbackMs: number) {
    let now = 0;
    let seq = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const starts: number[] = [];
    const pending: Array<{ at: number; resolve: () => void }> = [];
    let active = 0;
    let maxActive = 0;

    const deps = {
      isHidden: () => false,
      onVisibilityChange: () => () => {},
      schedule: (fn: () => void, ms: number) => { const id = seq++; timers.set(id, { at: now + ms, fn }); return id; },
      cancel: (id: number) => { timers.delete(id); },
      now: () => now,
      callback: () => {
        starts.push(now);
        active++; maxActive = Math.max(maxActive, active);
        // callbackMs 뒤에 완료되는 비동기 콜백(요청 지연 모사).
        return new Promise<void>((resolve) => {
          pending.push({ at: now + callbackMs, resolve: () => { active--; resolve(); } });
        });
      },
      intervalMs: 100,
    };

    return {
      deps, starts, get maxActive() { return maxActive; },
      /** 가짜 시간을 진행: 만기 콜백 완료 + 만기 타이머를 시간순 처리. */
      async advance(ms: number) {
        const target = now + ms;
        let guard = 0;
        while (guard++ < 100000) {
          let nextAt = Infinity; let kind: "cb" | "timer" | null = null;
          for (const pcb of pending) if (pcb.at <= target && pcb.at < nextAt) { nextAt = pcb.at; kind = "cb"; }
          for (const [, t] of timers) if (t.at <= target && t.at < nextAt) { nextAt = t.at; kind = "timer"; }
          if (kind === null) break;
          now = nextAt;
          if (kind === "cb") {
            const i = pending.findIndex((pcb) => pcb.at === nextAt);
            const [pcb] = pending.splice(i, 1);
            pcb.resolve();
          } else {
            let tid: number | null = null;
            for (const [id, t] of timers) if (t.at === nextAt) { tid = id; break; }
            if (tid !== null) { const t = timers.get(tid)!; timers.delete(tid); t.fn(); }
          }
          await flush();
        }
        now = target;
      },
    };
  }

  // 10) callback 60ms / interval 100ms → start간격은 ~100ms(30+지연 아님).
  {
    const h = makeTimedHarness(60);
    const stop = startVisibilityPoller(h.deps);
    await flush();
    await h.advance(350);
    // 시작가: [0,100,200,300] 근처(anchored). 치명적으로 160/320(=100+60 drift)이 아니어야 함.
    const gaps = h.starts.slice(1).map((t, i) => t - h.starts[i]);
    check(`anchored: 시작 간격이 interval(100)에 근접 (gaps=${JSON.stringify(gaps)})`,
      gaps.length >= 2 && gaps.every((gp) => gp === 100));
    check("anchored: 추가 콜백 걹침 0(single-flight 유지)", h.maxActive === 1);
    check("anchored: drift(160/320) 아님", !h.starts.includes(160) && !h.starts.includes(320));
    stop();
  }

  // 11) callback이 interval보다 길면(120ms > 100ms) 겹침 없이 즉시 재실행(delay=0).
  {
    const h = makeTimedHarness(120);
    const stop = startVisibilityPoller(h.deps);
    await flush();
    await h.advance(400);
    const gaps = h.starts.slice(1).map((t, i) => t - h.starts[i]);
    check(`slow-callback: 간격이 callback duration(120)으로 수렴(gaps=${JSON.stringify(gaps)})`,
      gaps.length >= 2 && gaps.every((gp) => gp === 120));
    check("slow-callback: 겹침 0", h.maxActive === 1);
    stop();
  }

  console.log(`\nvisibility-poller: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
  if (fail) process.exit(1);
}

run();
