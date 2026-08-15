/**
 * 야잘알봇 타이핑 인디케이터 — 실제 GeniusTypingIndicator 컴포넌트 마운트 회귀.
 *
 * 생각중 기록은 질문 바로 아래 `GeniusThinkingBubble` 이 맡는다. 이 컴포넌트는
 * waiting/retrying/idle 에서 중복 렌더하지 않고, failed 에서만 재시도 UI를 제공한다.
 * 실제 생각중 말풍선의 pending→완료 전이는 `genius-thinking-bubble-render.ts`가 검증한다.
 *
 * 실행: tsx --test scripts/qa/genius-typing-indicator-smoke.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import type * as ReactNamespace from "react";
import type { Root } from "react-dom/client";
import {
  BASEBALL_QA_OUTBOX_KEY,
  BASEBALL_QA_MAX_ATTEMPTS,
  BASEBALL_QA_REPLY_TIMEOUT_MS,
  applyBaseballQaPlayerPick,
  applyBaseballQaQuestionCorrection,
  attemptBaseballQaOutbox,
  declineBaseballQaQuestionCorrection,
  enqueueBaseballQaQuestion,
  expireBaseballQaReplyTimeouts,
  getBaseballQaReplyStates,
  observeBaseballQaReplies,
  readBaseballQaOutbox,
  resetBaseballQaQuestion,
} from "../../src/lib/baseball-qa/client-outbox";
import { BASEBALL_GENIUS_FALLBACK_ANSWER } from "../../src/lib/constants/baseball-genius";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
const globals = globalThis as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
for (const key of ["HTMLElement", "Element", "Node", "Event"]) {
  globals[key] = (dom.window as unknown as Record<string, unknown>)[key];
}
(globals as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "qa-anon-key";
// React의 act는 production 조건부 export에 없다. Vercel prebuild도 실제 DOM 훅 회귀를
// 실행할 수 있도록 어떤 runtime import보다 먼저 development 번들을 고정한다.
process.env.NODE_ENV = "development";

let React: typeof ReactNamespace;
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof ReactNamespace.act;
let GeniusTypingIndicator: typeof import("../../src/components/dm/GeniusTypingIndicator").default;
let useBaseballQaReplyRecovery: typeof import("../../src/lib/baseball-qa/use-reply-recovery").useBaseballQaReplyRecovery;
type GeniusTypingState = import("../../src/components/dm/GeniusTypingIndicator").GeniusTypingState;

async function loadReactHarness() {
  if (!React) React = await import("react");
  if (!createRoot) ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  if (typeof act !== "function") {
    throw new Error("React.act가 없다 — NODE_ENV=development가 runtime import보다 먼저여야 한다");
  }
  if (!useBaseballQaReplyRecovery) {
    ({ useBaseballQaReplyRecovery } = await import("../../src/lib/baseball-qa/use-reply-recovery"));
  }
}

const GENIUS_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";

class MemoryStorage {
  private values = new Map<string, string>();

  constructor(initial?: string) {
    if (initial) this.values.set(BASEBALL_QA_OUTBOX_KEY, initial);
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function response(status: number) {
  return new Response(null, { status });
}

function assertMissedRealtimeRecoveryWiring(source: string) {
  assert.match(
    source,
    /if \(attempt\.completed\.length > 0\) \{[\s\S]*?syncBaseballQaRepliesRef\.current\(\);[\s\S]*?\}/,
    "HTTP 성공 뒤 DB 정본 재조회 배선이 있어야 한다",
  );
  assert.match(
    source,
    /useBaseballQaReplyRecovery\(\{[\s\S]*?processOutbox: processBaseballQaOutbox/,
    "실제 reply recovery 훅이 outbox 처리 경로에 결속되어야 한다",
  );
  assert.match(
    source,
    /entry\.conversationId === conversationId && !entry\.awaitingPlayerPick/,
    "강제 동기화는 현재 대화의 미완료 질문에만 결속되어야 한다",
  );
  assert.match(
    source,
    /requestLoad\(\(\) => loadMessages\("merge"\)\)/,
    "강제 동기화는 기존 single-flight 메시지 재조회를 재사용해야 한다",
  );
}

test("HTTP 성공 뒤 Realtime INSERT를 놓쳐도 exact 답변을 강제 재조회한다", () => {
  const source = readFileSync("src/lib/supabase/useDM.ts", "utf8");
  assertMissedRealtimeRecoveryWiring(source);

  assert.throws(
    () => assertMissedRealtimeRecoveryWiring(
      source.replace("if (attempt.completed.length > 0) {", "if (false) {"),
    ),
    /HTTP 성공 뒤 DB 정본 재조회/,
    "성공 직후 재조회 배선을 죽이면 게이트가 RED여야 한다",
  );
  assert.throws(
    () => assertMissedRealtimeRecoveryWiring(
      source.replace("useBaseballQaReplyRecovery({", "void ({"),
    ),
    /reply recovery 훅/,
    "production 훅 결속을 죽이면 게이트가 RED여야 한다",
  );
});

test("acknowledged/202 무답변은 유계 시간 뒤 실제 recovery 훅에서 failed로 전환된다", async () => {
  await loadReactHarness();

  const storage = new MemoryStorage();
  enqueueBaseballQaQuestion(storage, { conversationId: "conv", messageId: 99 });
  await attemptBaseballQaOutbox(
    storage,
    "token",
    (async () => response(202)) as typeof fetch,
    1_000,
  );

  let tick: (() => void) | null = null;
  const originalSetInterval = window.setInterval;
  const originalClearInterval = window.clearInterval;
  window.setInterval = ((callback: TimerHandler) => {
    tick = callback as () => void;
    return 1;
  }) as typeof window.setInterval;
  window.clearInterval = (() => undefined) as typeof window.clearInterval;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let syncCalls = 0;
  let processCalls = 0;
  function Harness() {
    const [states, setStates] = React.useState(
      getBaseballQaReplyStates(readBaseballQaOutbox(storage)),
    );
    useBaseballQaReplyRecovery({
      replyStates: states,
      setReplyStates: setStates,
      storage,
      nowMs: () => 1_000 + BASEBALL_QA_REPLY_TIMEOUT_MS,
      syncReplies: () => { syncCalls += 1; },
      processOutbox: () => { processCalls += 1; },
    });
    return React.createElement("div", { "data-state": states[99] ?? "idle" });
  }

  try {
    await act(async () => { root.render(React.createElement(Harness)); });
    assert.equal(container.firstElementChild?.getAttribute("data-state"), "waiting");
    assert.ok(tick, "production recovery interval callback이 등록되어야 한다");
    await act(async () => { tick?.(); });
    assert.equal(container.firstElementChild?.getAttribute("data-state"), "failed");
    assert.equal(readBaseballQaOutbox(storage)[0]?.attempts, BASEBALL_QA_MAX_ATTEMPTS);
    assert.equal(syncCalls, 1);
    assert.equal(processCalls, 1);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    window.setInterval = originalSetInterval;
    window.clearInterval = originalClearInterval;
  }
});

test("timeout 직전은 waiting을 유지하고 retry는 질문 deadline을 새로 시작한다", async () => {
  const storage = new MemoryStorage();
  enqueueBaseballQaQuestion(storage, { conversationId: "conv", messageId: 98 });
  await attemptBaseballQaOutbox(
    storage,
    "token",
    (async () => response(200)) as typeof fetch,
    5_000,
  );
  await attemptBaseballQaOutbox(
    storage,
    "token",
    (async () => response(500)) as typeof fetch,
    5_000 + BASEBALL_QA_REPLY_TIMEOUT_MS - 1,
  );
  assert.equal(getBaseballQaReplyStates(readBaseballQaOutbox(storage))[98], "waiting");

  await attemptBaseballQaOutbox(
    storage,
    "token",
    (async () => response(500)) as typeof fetch,
    5_000 + BASEBALL_QA_REPLY_TIMEOUT_MS,
  );
  assert.equal(getBaseballQaReplyStates(readBaseballQaOutbox(storage))[98], "failed");
  resetBaseballQaQuestion(storage, 98);
  assert.equal(getBaseballQaReplyStates(readBaseballQaOutbox(storage))[98], "waiting");
  assert.equal(readBaseballQaOutbox(storage)[0]?.responsePendingSinceMs, undefined);
});

test("90초 뒤 picker·교정 선택/거절은 stale deadline을 버리고 새 요청을 시작한다", () => {
  const stale = (messageId: number) => new MemoryStorage(JSON.stringify([{
    conversationId: "conv", messageId, attempts: 0, acknowledged: true,
    awaitingPlayerPick: true, responsePendingSinceMs: 1_000,
  }]));
  const cases: Array<[string, (storage: MemoryStorage, messageId: number) => boolean]> = [
    ["player pick", (storage, messageId) => applyBaseballQaPlayerPick(storage, "conv", messageId, "69102")],
    ["correction select", (storage, messageId) =>
      applyBaseballQaQuestionCorrection(storage, "conv", messageId, "문보경 별명")],
    ["correction decline", (storage, messageId) =>
      declineBaseballQaQuestionCorrection(storage, "conv", messageId)],
  ];

  cases.forEach(([label, select], index) => {
    const messageId = 81 + index;
    const storage = stale(messageId);
    assert.equal(select(storage, messageId), true, `${label}: 선택 요청이 enqueue되어야 한다`);
    const entry = readBaseballQaOutbox(storage)[0];
    assert.equal(entry?.attempts, 0, `${label}: attempts를 새로 시작해야 한다`);
    assert.equal(entry?.acknowledged, false, `${label}: POST 전 waiting 상태여야 한다`);
    assert.equal(entry?.responsePendingSinceMs, undefined, `${label}: 과거 deadline을 지워야 한다`);
    assert.deepEqual(
      expireBaseballQaReplyTimeouts(storage, 1_000 + BASEBALL_QA_REPLY_TIMEOUT_MS),
      [],
      `${label}: 선택 직후 과거 deadline으로 failed 전환되면 안 된다`,
    );
    assert.equal(getBaseballQaReplyStates(readBaseballQaOutbox(storage))[messageId], "waiting");
  });
});

test("picker·교정 3경로 deadline reset 배선 제거는 모두 RED다", () => {
  const source = readFileSync("src/lib/baseball-qa/client-outbox.ts", "utf8");
  const sections: Array<[string, string, string]> = [
    ["applyBaseballQaQuestionCorrection", "declineBaseballQaQuestionCorrection", "교정 선택"],
    ["declineBaseballQaQuestionCorrection", "applyBaseballQaPlayerPick", "교정 거절"],
    ["applyBaseballQaPlayerPick", "collectBaseballQaAnsweredQuestionIds", "선수 선택"],
  ];
  const assertWiring = (candidate: string) => {
    for (const [name, nextName, label] of sections) {
      const start = candidate.indexOf(`export function ${name}`);
      const end = candidate.indexOf(`export function ${nextName}`, start + 1);
      assert.ok(start >= 0 && end > start, `${label}: 함수 구획을 찾지 못했다`);
      assert.match(
        candidate.slice(start, end),
        /responsePendingSinceMs: undefined/,
        `${label}: stale deadline reset이 필요하다`,
      );
    }
  };
  assertWiring(source);
  for (const [name, nextName, label] of sections) {
    const start = source.indexOf(`export function ${name}`);
    const end = source.indexOf(`export function ${nextName}`, start + 1);
    const section = source.slice(start, end);
    const mutated = source.slice(0, start) +
      section.replace(/\s*responsePendingSinceMs: undefined,?/, "") +
      source.slice(end);
    assert.throws(() => assertWiring(mutated), /stale deadline reset/, `${label} reset 제거가 RED여야 한다`);
  }
});

test("질문별 deadline은 다른 질문과 picker 대기를 건드리지 않는다", () => {
  const storage = new MemoryStorage(JSON.stringify([
    { conversationId: "conv", messageId: 91, attempts: 0, acknowledged: true, responsePendingSinceMs: 1_000 },
    { conversationId: "conv", messageId: 92, attempts: 0, acknowledged: true, responsePendingSinceMs: 2_000 },
    { conversationId: "conv", messageId: 93, attempts: 0, acknowledged: true, awaitingPlayerPick: true, responsePendingSinceMs: 1_000 },
  ]));
  assert.deepEqual(
    expireBaseballQaReplyTimeouts(storage, 1_000 + BASEBALL_QA_REPLY_TIMEOUT_MS),
    [91],
  );
  assert.deepEqual(getBaseballQaReplyStates(readBaseballQaOutbox(storage)), {
    91: "failed",
    92: "waiting",
  });
  assert.equal(readBaseballQaOutbox(storage).find((entry) => entry.messageId === 93)?.attempts, 0);
});

test("연속 질문은 messageId별 waiting/failed 상태를 독립 유지한다", async () => {
  const storage = new MemoryStorage();
  enqueueBaseballQaQuestion(storage, { conversationId: "conv", messageId: 101 });
  enqueueBaseballQaQuestion(storage, { conversationId: "conv", messageId: 102 });

  const request = (async (_url: URL | RequestInfo, init?: RequestInit) => {
    const messageId = JSON.parse(String(init?.body)).messageId as number;
    return response(messageId === 101 ? 500 : 202);
  }) as typeof fetch;
  for (let i = 0; i < 5; i += 1) {
    await attemptBaseballQaOutbox(storage, "token", request);
  }

  assert.deepEqual(getBaseballQaReplyStates(readBaseballQaOutbox(storage)), {
    101: "failed",
    102: "waiting",
  });
});

test("HTTP 200 선도착 뒤에도 exact 답변을 역순 관측할 때까지 질문별로 유지한다", async () => {
  const storage = new MemoryStorage();
  enqueueBaseballQaQuestion(storage, { conversationId: "conv", messageId: 201 });
  enqueueBaseballQaQuestion(storage, { conversationId: "conv", messageId: 202 });

  await attemptBaseballQaOutbox(
    storage,
    "token",
    (async () => response(200)) as typeof fetch,
  );
  assert.deepEqual(getBaseballQaReplyStates(readBaseballQaOutbox(storage)), {
    201: "waiting",
    202: "waiting",
  }, "HTTP 200만으로 인디케이터를 종료하면 안 된다");

  assert.deepEqual(
    observeBaseballQaReplies(storage, [{
      sender_id: GENIUS_ID,
      dedup_key: "baseball-genius:202",
    }], GENIUS_ID),
    [202],
    "B 답변을 먼저 관측하면 B만 종료해야 한다",
  );
  assert.deepEqual(getBaseballQaReplyStates(readBaseballQaOutbox(storage)), {
    201: "waiting",
  });

  assert.deepEqual(
    observeBaseballQaReplies(storage, [{
      sender_id: GENIUS_ID,
      dedup_key: "baseball-genius:201",
    }], GENIUS_ID),
    [201],
  );
  assert.deepEqual(readBaseballQaOutbox(storage), []);
});

test("Realtime 단절·새로고침 뒤에도 polling에서 exact 답변을 볼 때까지 유지한다", async () => {
  const beforeRefresh = new MemoryStorage();
  enqueueBaseballQaQuestion(beforeRefresh, { conversationId: "conv", messageId: 301 });
  await attemptBaseballQaOutbox(
    beforeRefresh,
    "token",
    (async () => response(200)) as typeof fetch,
  );

  const afterRefresh = new MemoryStorage(beforeRefresh.getItem(BASEBALL_QA_OUTBOX_KEY) ?? undefined);
  assert.deepEqual(getBaseballQaReplyStates(readBaseballQaOutbox(afterRefresh)), {
    301: "waiting",
  }, "재진입 시 처리 중 상태를 복원해야 한다");

  assert.deepEqual(
    observeBaseballQaReplies(afterRefresh, [{
      sender_id: GENIUS_ID,
      dedup_key: "baseball-genius:301",
    }], GENIUS_ID),
    [301],
    "Realtime 없이 기존 메시지 polling 결과로도 exact 답변을 종결해야 한다",
  );
  assert.deepEqual(readBaseballQaOutbox(afterRefresh), []);
});

test("다시 시도는 선택한 failed messageId만 요청한다", async () => {
  const storage = new MemoryStorage();
  enqueueBaseballQaQuestion(storage, { conversationId: "conv", messageId: 401 });
  enqueueBaseballQaQuestion(storage, { conversationId: "conv", messageId: 402 });

  const seedRequest = (async (_url: URL | RequestInfo, init?: RequestInit) => {
    const messageId = JSON.parse(String(init?.body)).messageId as number;
    return response(messageId === 401 ? 500 : 200);
  }) as typeof fetch;
  for (let i = 0; i < 5; i += 1) {
    await attemptBaseballQaOutbox(storage, "token", seedRequest);
  }
  assert.deepEqual(getBaseballQaReplyStates(readBaseballQaOutbox(storage)), {
    401: "failed",
    402: "waiting",
  });

  resetBaseballQaQuestion(storage, 401);
  const requested: number[] = [];
  await attemptBaseballQaOutbox(
    storage,
    "token",
    (async (_url: URL | RequestInfo, init?: RequestInit) => {
      requested.push(JSON.parse(String(init?.body)).messageId as number);
      return response(202);
    }) as typeof fetch,
  );
  assert.deepEqual(requested, [401]);
});

test("야잘알봇 타이핑 인디케이터 3전이", async () => {
  await loadReactHarness();
  GeniusTypingIndicator = (await import("../../src/components/dm/GeniusTypingIndicator")).default;

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  let root!: Root;

  let retryCount = 0;
  const render = (state: GeniusTypingState) => {
    act(() => {
      root.render(
        React.createElement(GeniusTypingIndicator, {
          state,
          onRetry: () => { retryCount += 1; },
        }),
      );
    });
  };

  act(() => { root = createRoot(container); });

  // waiting/retrying은 질문 아래 영속 말풍선이 담당하므로 여기서는 중복 렌더하지 않는다.
  for (const state of ["waiting", "retrying", "idle"] as const) {
    render(state);
    assert.equal(
      container.querySelector('[data-testid="genius-typing-indicator"]'),
      null,
      `${state} 상태에서 별도 인디케이터가 중복 렌더되면 안 된다`,
    );
  }

  // 실패 → 오류 + 다시 시도 버튼, 클릭 시 onRetry 호출
  render("failed");
  const failedEl = container.querySelector('[data-state="failed"]');
  assert.ok(failedEl, "failed 상태에서 오류 UI가 렌더되어야 한다");
  assert.ok((failedEl!.textContent ?? "").includes(BASEBALL_GENIUS_FALLBACK_ANSWER));
  assert.doesNotMatch(failedEl!.textContent ?? "", /답변을 받지 못했어요/);
  const retryBtn = failedEl!.querySelector("button");
  assert.ok(retryBtn, "다시 시도 버튼이 있어야 한다");
  assert.equal(container.querySelector('[role="status"]'), null, "failed 시 대기 인디케이터는 없어야 한다");
  act(() => { retryBtn!.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
  assert.equal(retryCount, 1, "다시 시도 클릭 시 onRetry 가 호출되어야 한다");

  act(() => { root.unmount(); });
  console.log("✅ 야잘알봇 타이핑 인디케이터 3전이 회귀 통과");
});
