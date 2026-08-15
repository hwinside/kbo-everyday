/** 실제 useDMChat 경로 — 질문 2개 선렌더 → B Realtime → A recovery merge 순서에서도 exact DOM 결속. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import type * as ReactNamespace from "react";
import { BASEBALL_QA_OUTBOX_KEY } from "../../src/lib/baseball-qa/client-outbox";

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "qa-anon-key";
process.env.NODE_ENV = "development";

const GENIUS_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
for (const key of ["HTMLElement", "Element", "Node", "Event", "MouseEvent", "localStorage"]) {
  globals[key] = (dom.window as unknown as Record<string, unknown>)[key];
}
const raf = (callback: (time: number) => void) => dom.window.setTimeout(() => callback(Date.now()), 16);
globals.requestAnimationFrame = raf;
globals.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id);
(dom.window as unknown as Record<string, unknown>).requestAnimationFrame = raf;
(dom.window as unknown as Record<string, unknown>).cancelAnimationFrame = globals.cancelAnimationFrame;
(dom.window as unknown as Record<string, unknown>).matchMedia = () => ({
  matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});
(dom.window.Element.prototype as unknown as Record<string, unknown>).scrollIntoView = () => {};
(globals as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 실제 recovery 훅의 3초 tick을 기다리지 않고 결정론적으로 실행한다.
type Timer = { callback: () => void; ms: number; active: boolean };
const timers: Timer[] = [];
const fakeSetInterval = ((callback: () => void, ms = 0) => {
  const timer: Timer = { callback, ms, active: true };
  timers.push(timer);
  return timer as unknown as ReturnType<typeof setInterval>;
}) as typeof setInterval;
const fakeClearInterval = ((handle: ReturnType<typeof setInterval>) => {
  const timer = handle as unknown as Timer | null;
  if (timer && typeof timer === "object") timer.active = false;
}) as typeof clearInterval;
globals.setInterval = fakeSetInterval;
globals.clearInterval = fakeClearInterval;
(dom.window as unknown as { setInterval: typeof setInterval }).setInterval = fakeSetInterval;
(dom.window as unknown as { clearInterval: typeof clearInterval }).clearInterval = fakeClearInterval;

function assertLateArrivalWiring(source: string) {
  assert.match(
    source,
    /mode === "replace" \? mapped : mergeDmMessagesById\(prev, mapped\)/,
    "late DB snapshot은 기존 질문/답변과 id merge해야 한다",
  );
  assert.match(
    source,
    /observeBaseballQaMessages\(\[msg\]\)[\s\S]*?setMessages\(\(prev\) =>[\s\S]*?\.\.\.prev,[\s\S]*?\.\.\.msg/,
    "Realtime INSERT는 exact payload를 관측한 뒤 기존 DOM에 append해야 한다",
  );
}

async function waitFor(assertion: () => void, act: typeof ReactNamespace.act, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch (error) { last = error; }
    await act(async () => { await new Promise((resolve) => dom.window.setTimeout(resolve, 5)); });
  }
  throw last;
}

async function main() {
  const pageSource = readFileSync("src/app/(main)/messages/[conversationId]/page.tsx", "utf8");
  const dmSource = readFileSync("src/lib/supabase/useDM.ts", "utf8");
  assert.match(pageSource, /data-message-id=\{msg\.id\}/, "visible message DOM id 결속이 필요하다");
  assert.match(pageSource, /data-genius-question-id=\{geniusReply\?\.question_message_id\}/, "answer DOM은 payload의 exact 질문 id에 결속돼야 한다");
  assert.match(pageSource, /questionMessageId=\{Number\(messageId\)\}/, "typing DOM도 질문 id에 결속돼야 한다");
  assertLateArrivalWiring(dmSource);
  assert.throws(
    () => assertLateArrivalWiring(dmSource.replace(
      'mode === "replace" ? mapped : mergeDmMessagesById(prev, mapped)',
      "mapped",
    )),
    /id merge/,
    "late merge를 replace로 바꾸면 실제 질문 DOM 보존 계약이 RED여야 한다",
  );
  assert.throws(
    () => assertLateArrivalWiring(dmSource.replace("observeBaseballQaMessages([msg]);", "")),
    /exact payload/,
    "Realtime 답변 관측을 제거하면 질문별 typing 종료 계약이 RED여야 한다",
  );

  const React = await import("react") as typeof ReactNamespace;
  const { createRoot } = await import("react-dom/client");
  const act = React.act;
  assert.equal(typeof act, "function", "development React.act가 필요하다");
  const { supabase } = await import("../../src/lib/supabase/client");
  const { AuthProvider } = await import("../../src/lib/supabase/AuthContext");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { PathParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  const DMChatPage = (await import("../../src/app/(main)/messages/[conversationId]/page")).default;

  const q1 = { id: 201, conversation_id: "conv", sender_id: "me", content: "첫 질문", is_read: true, created_at: "2026-08-14T00:00:01Z" };
  const q2 = { id: 202, conversation_id: "conv", sender_id: "me", content: "둘째 질문", is_read: true, created_at: "2026-08-14T00:00:02Z" };
  const b2 = { id: 303, conversation_id: "conv", sender_id: GENIUS_ID, content: "둘째 질문 exact 답변", dedup_key: "baseball-genius:202", is_read: false, created_at: "2026-08-14T00:00:03Z", payload: { type: "baseball_genius_reply", reply_kind: "answer", match_path: "dictionary", question_message_id: 202 } };
  const a1 = { id: 304, conversation_id: "conv", sender_id: GENIUS_ID, content: "첫 질문 exact 답변", dedup_key: "baseball-genius:201", is_read: false, created_at: "2026-08-14T00:00:04Z", payload: { type: "baseball_genius_reply", reply_kind: "answer", match_path: "dictionary", question_message_id: 201 } };
  let rows = [q2, q1];
  let realtimeInsert: ((payload: { new: typeof b2 }) => Promise<void>) | null = null;

  dom.window.localStorage.setItem(BASEBALL_QA_OUTBOX_KEY, JSON.stringify([
    { conversationId: "conv", messageId: 201, attempts: 0, acknowledged: true, responsePendingSinceMs: Date.now() },
    { conversationId: "conv", messageId: 202, attempts: 0, acknowledged: true, responsePendingSinceMs: Date.now() },
  ]));

  const mutable = supabase as unknown as { from: (table: string) => unknown; channel: (name: string) => unknown; removeChannel: (channel: unknown) => Promise<string>; auth: unknown };
  const original = { from: mutable.from, channel: mutable.channel, removeChannel: mutable.removeChannel, auth: mutable.auth, fetch: globalThis.fetch };
  const profile = { id: "me", nickname: "테스터", team_id: 1, favorite_players: [], points: 0, grade: "rookie", avatar_url: null, invited_by: null };

  mutable.from = (table: string) => {
    if (table === "dm_conversations") {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { user1_id: "me", user2_id: GENIUS_ID } }) };
      return query;
    }
    if (table === "profiles") {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: profile, error: null }), in: async () => ({ data: [profile, { ...profile, id: GENIUS_ID, nickname: "야잘알봇" }] }) };
      return query;
    }
    if (table === "user_blocks") {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null }) };
      return query;
    }
    if (table !== "dm_messages") throw new Error(`unexpected table: ${table}`);
    const query = {
      select: () => query, eq: () => query, order: () => query, limit: async () => ({ data: rows }),
      update: () => {
        const updateQuery = { eq: () => updateQuery, or: () => updateQuery, then: (resolve?: (value: { data: null }) => void) => resolve?.({ data: null }) };
        return updateQuery;
      },
    };
    return query;
  };
  mutable.channel = () => {
    const channel = {
      on: (_event: string, filter: { event?: string; table?: string }, callback: (payload: { new: typeof b2 }) => Promise<void>) => {
        if (filter.event === "INSERT" && filter.table === "dm_messages") realtimeInsert = callback;
        return channel;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.("SUBSCRIBED"); return channel; },
    };
    return channel;
  };
  mutable.removeChannel = async () => "ok";
  mutable.auth = {
    getSession: async () => ({ data: { session: { user: { id: "me" }, access_token: "qa-token" } } }),
    setSession: async () => ({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("/api/baseball-qa")) return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ profile, ratings: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, hmrRefresh() {} };
  try {
    await act(async () => {
      root.render(React.createElement(
        AppRouterContext.Provider, { value: router as never },
        React.createElement(PathParamsContext.Provider, { value: { conversationId: "conv" } }, React.createElement(AuthProvider, null, React.createElement(DMChatPage))),
      ));
    });

    await waitFor(() => {
      assert.match(container.querySelector('[data-message-id="201"]')?.textContent ?? "", /첫 질문/);
      assert.match(container.querySelector('[data-message-id="202"]')?.textContent ?? "", /둘째 질문/);
      // reload에서 localStorage outbox만 남은 경우 생각중 기록을 되살리지 않는다.
      assert.equal(container.querySelectorAll('[data-genius-typing-question-id]').length, 0);
      assert.equal(container.querySelector('[data-message-id="303"]'), null);
    }, act);

    assert.ok(realtimeInsert, "실제 dm_messages Realtime INSERT callback을 캡처해야 한다");
    rows = [b2, q2, q1];
    await act(async () => { await realtimeInsert!({ new: b2 }); });
    await waitFor(() => {
      const answer = container.querySelector('[data-message-id="303"][data-genius-question-id="202"]');
      assert.match(answer?.textContent ?? "", /둘째 질문 exact 답변/);
      assert.equal(container.querySelectorAll('[data-genius-typing-question-id]').length, 0);
    }, act);

    rows = [a1, b2, q2, q1];
    const recoveryTick = timers.find((timer) => timer.active && timer.ms === 3_000);
    assert.ok(recoveryTick, "실제 3초 reply recovery tick을 캡처해야 한다");
    await act(async () => { recoveryTick.callback(); });
    await waitFor(() => {
      const first = container.querySelector('[data-message-id="304"][data-genius-question-id="201"]');
      const second = container.querySelector('[data-message-id="303"][data-genius-question-id="202"]');
      assert.match(first?.textContent ?? "", /첫 질문 exact 답변/);
      assert.doesNotMatch(first?.textContent ?? "", /둘째 질문 exact 답변/);
      assert.match(second?.textContent ?? "", /둘째 질문 exact 답변/);
      assert.doesNotMatch(second?.textContent ?? "", /첫 질문 exact 답변/);
      assert.equal(container.querySelectorAll('[data-genius-typing-question-id]').length, 0, "두 exact 답변 뒤 typing은 모두 종료돼야 한다");
    }, act);
    console.log("✅ 질문 2개 → B Realtime → A recovery merge actual DM DOM exact 결속 PASS");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    mutable.from = original.from; mutable.channel = original.channel; mutable.removeChannel = original.removeChannel; mutable.auth = original.auth; globalThis.fetch = original.fetch;
    dom.window.close();
  }
}

void main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
