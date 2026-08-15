/**
 * 실제 DMChatPage/useDMChat 종단: draft 첫 질문 → route 승격 → 실제 Realtime 답변 INSERT
 * (답변 DOM + 말풍선 잔존 + pending 해제) → Q2 최신 1개 → failed → answer-before-outbox
 * (RPC 반환 전 답변 선도착 → outbox 0 + 말풍선 잔존) → reload 0.
 */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type * as ReactNamespace from "react";
import type { Root } from "react-dom/client";
import {
  BASEBALL_QA_MAX_ATTEMPTS,
  BASEBALL_QA_OUTBOX_KEY,
} from "../../src/lib/baseball-qa/client-outbox";

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "***";
process.env.NODE_ENV = "development";

const GENIUS_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
const CONVERSATION_ID = "actual-conversation";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
for (const key of ["HTMLElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "localStorage", "sessionStorage"]) {
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

async function waitFor(assertion: () => void, act: typeof ReactNamespace.act, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch (error) { last = error; }
    await act(async () => { await new Promise((resolve) => dom.window.setTimeout(resolve, 5)); });
  }
  throw last;
}

type Message = {
  id: number; conversation_id: string; sender_id: string; content: string;
  is_read: boolean; created_at: string; dedup_key?: string; payload?: Record<string, unknown>;
};
const profile = { id: "me", nickname: "테스터", team_id: 1, favorite_players: [], points: 0, grade: "rookie", avatar_url: null, invited_by: null };
const rows: Message[] = [];
const QUESTION_IDS = [101, 202, 303];
const CREATED_AT: Record<number, string> = {
  101: "2026-08-15T00:00:01Z", 150: "2026-08-15T00:00:02Z", 202: "2026-08-15T00:00:03Z",
  303: "2026-08-15T00:00:05Z", 350: "2026-08-15T00:00:06Z",
};
let questionIndex = 0;
let routePromoted = false;

async function main() {
  const React = await import("react") as typeof ReactNamespace;
  const { createRoot } = await import("react-dom/client");
  const act = React.act;
  assert.equal(typeof act, "function");
  const { supabase } = await import("../../src/lib/supabase/client");
  const { AuthProvider } = await import("../../src/lib/supabase/AuthContext");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { PathParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  const DMChatPage = (await import("../../src/app/(main)/messages/[conversationId]/page")).default;

  const mutable = supabase as unknown as {
    from: (table: string) => unknown; rpc: (fn: string, args: Record<string, unknown>) => unknown;
    channel: (name: string) => unknown; removeChannel: (channel: unknown) => Promise<string>; auth: unknown;
  };
  const original = { from: mutable.from, rpc: mutable.rpc, channel: mutable.channel, removeChannel: mutable.removeChannel, auth: mutable.auth, fetch: globalThis.fetch };
  const thenable = (value: unknown = { data: null, error: null }) => ({
    then(resolve: (value: unknown) => unknown) { return Promise.resolve(value).then(resolve); },
  });
  mutable.from = (table: string) => {
    if (table === "dm_messages") {
      const query = {
        select: () => query, eq: () => query, or: () => query, order: () => query,
        limit: async () => ({ data: [...rows] }),
        update: () => query,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
      };
      return query;
    }
    if (table === "dm_conversations") {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { user1_id: "me", user2_id: GENIUS_ID } }) };
      return query;
    }
    if (table === "profiles") {
      const genius = { ...profile, id: GENIUS_ID, nickname: "야잘알봇", team_id: null };
      const query = {
        select: () => query, eq: () => query,
        maybeSingle: async () => ({ data: profile, error: null }),
        in: async () => ({ data: [profile, genius], error: null }),
      };
      return query;
    }
    if (table === "user_blocks") {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error: null }), insert: () => thenable() };
      return query;
    }
    throw new Error(`unexpected table: ${table}`);
  };
  type RealtimePayload = { new: Message };
  const realtimeHandlers = new Map<string, (payload: RealtimePayload) => unknown>();
  // 실제 서버 파이프라인처럼 봇 답변을 Realtime INSERT callback으로 배달한다(모의 DOM 주입 아님).
  const deliverGeniusAnswer = async (id: number, questionMessageId: number, content: string) => {
    const message: Message = {
      id, conversation_id: CONVERSATION_ID, sender_id: GENIUS_ID, content,
      is_read: false, created_at: CREATED_AT[id], dedup_key: `baseball-genius:${questionMessageId}`,
    };
    rows.push(message);
    const handler = realtimeHandlers.get(`dm:${CONVERSATION_ID}`);
    assert.ok(handler, "실제 대화 Realtime 구독(on callback)이 있어야 한다");
    await handler({ new: message });
  };
  mutable.rpc = (fn, args) => {
    assert.equal(fn, "send_dm_message_atomic");
    assert.equal(args.p_target_user_id, GENIUS_ID);
    const id = QUESTION_IDS[questionIndex];
    questionIndex += 1;
    rows.push({
      id, conversation_id: CONVERSATION_ID, sender_id: "me", content: String(args.p_content),
      is_read: true, created_at: CREATED_AT[id],
    });
    return {
      single: async () => {
        // Q3: 최종 답변이 질문 RPC 응답보다 먼저 Realtime으로 도착하는 answer-before-outbox race.
        if (id === 303) await deliverGeniusAnswer(350, 303, "선도착 답변입니다");
        return { data: { conversation_id: CONVERSATION_ID, message_id: id }, error: null };
      },
    };
  };
  mutable.channel = (name: string) => {
    const channel = {
      on: (_event: string, _filter: unknown, callback: (payload: RealtimePayload) => unknown) => {
        realtimeHandlers.set(name, callback);
        return channel;
      },
      subscribe: (callback?: (status: string) => void) => { callback?.("SUBSCRIBED"); return channel; },
    };
    return channel;
  };
  mutable.removeChannel = async () => "ok";
  mutable.auth = {
    getSession: async () => ({ data: { session: { user: { id: "me" }, access_token: "***" } } }),
    setSession: async () => ({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("/api/baseball-qa")) return new Response(null, { status: 202 });
    if (url.includes("/api/profile")) return new Response(JSON.stringify([profile]), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ ratings: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  function Harness({ initialConversationId }: { initialConversationId: string }) {
    const [conversationId, setConversationId] = React.useState(initialConversationId);
    const router = React.useMemo(() => ({
      back() {}, forward() {}, refresh() {}, push() {}, prefetch() {}, hmrRefresh() {},
      replace(path: string) {
        const match = path.match(/^\/messages\/(.+)$/);
        if (match) {
          routePromoted = match[1] === CONVERSATION_ID;
          setConversationId(match[1]);
        }
      },
    }), [setConversationId]);
    return React.createElement(
      AppRouterContext.Provider, { value: router as never },
      React.createElement(
        PathParamsContext.Provider, { value: { conversationId } },
        React.createElement(AuthProvider, null, React.createElement(DMChatPage)),
      ),
    );
  }

  const typeAndSend = async (container: HTMLElement, value: string) => {
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(textarea, value);
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await waitFor(() => assert.equal((container.querySelector("textarea") as HTMLTextAreaElement).value, value), act);
    await act(async () => {
      container.querySelector('button[aria-label="쪽지 보내기"]')!
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };
  const attachedThinking = (container: HTMLElement, id: number) =>
    container.querySelector(`[data-message-id="${id}"]`)?.nextElementSibling?.getAttribute("data-testid") === "genius-thinking-bubble";

  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(Harness, { initialConversationId: `new-${GENIUS_ID}` })); });
    await waitFor(() => assert.ok(container.querySelector("textarea")), act);

    await typeAndSend(container, "첫 질문");
    await waitFor(() => {
      assert.equal(routePromoted, true, "router.replace가 실제 conversation으로 승격해야 한다");
      assert.match(container.querySelector('[data-message-id="101"]')?.textContent ?? "", /첫 질문/);
      assert.equal(attachedThinking(container, 101), true, "route 승격 뒤 Q1 thinking이 남아야 한다");
    }, act);
    console.log("✅ actual Q1 send → new-* route promotion → thinking1 retained");

    // 실제 Realtime callback으로 봇 최종 답변 INSERT를 배달한다.
    await act(async () => { await deliverGeniusAnswer(150, 101, "첫 답변입니다"); });
    await waitFor(() => {
      assert.match(container.querySelector('[data-message-id="150"]')?.textContent ?? "", /첫 답변입니다/,
        "실제 Realtime 답변 INSERT가 DOM에 보여야 한다");
      assert.equal(attachedThinking(container, 101), true, "답변 도착 후에도 Q1 생각중 말풍선 기록이 남아야 한다");
      const bubble = container.querySelector('[data-message-id="101"]')?.nextElementSibling;
      assert.equal(bubble?.getAttribute("data-pending"), "false", "답변 도착 후 pending 점/status는 해제돼야 한다");
      assert.equal(bubble?.querySelector('[role="status"]') == null, true, "role=status 가 남아 있다");
      const outbox = JSON.parse(dom.window.localStorage.getItem(BASEBALL_QA_OUTBOX_KEY) ?? "[]") as Array<{ messageId: number }>;
      assert.equal(outbox.some((entry) => entry.messageId === 101), false, "답변 관측 뒤 outbox 101 항목은 제거돼야 한다");
    }, act);
    console.log("✅ actual Realtime answer → answer DOM + bubble retained + pending cleared");

    await typeAndSend(container, "둘째 질문");
    await waitFor(() => {
      assert.match(container.querySelector('[data-message-id="202"]')?.textContent ?? "", /둘째 질문/);
      assert.equal(attachedThinking(container, 101), false, "Q2 뒤 Q1 thinking은 제거돼야 한다");
      assert.equal(attachedThinking(container, 202), true, "Q2 thinking만 최신 1개로 남아야 한다");
      assert.equal(container.querySelectorAll('[data-testid="genius-thinking-bubble"]').length, 1);
    }, act);
    console.log("✅ actual Q2 send → latest thinking only");

    // 실제 hook의 online 처리로 Q2를 failed 상태로 바꾼다. 기록은 남되 pending 점/status는 멈춘다.
    const stored = JSON.parse(dom.window.localStorage.getItem(BASEBALL_QA_OUTBOX_KEY) ?? "[]") as Array<Record<string, unknown>>;
    for (const entry of stored) {
      if (entry.messageId === 202) { entry.attempts = BASEBALL_QA_MAX_ATTEMPTS; entry.acknowledged = false; }
    }
    dom.window.localStorage.setItem(BASEBALL_QA_OUTBOX_KEY, JSON.stringify(stored));
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("online")); });
    await waitFor(() => {
      const bubble = container.querySelector('[data-message-id="202"]')?.nextElementSibling;
      assert.equal(bubble?.getAttribute("data-pending"), "false");
      assert.equal(bubble?.querySelector('[role="status"]') == null, true, "role=status 가 남아 있다");
      assert.ok(container.querySelector('[data-state="failed"] button'));
    }, act);
    console.log("✅ actual failed → thinking record retained, pending stopped, retry shown");

    // RPC 반환 전 답변 선도착: rpc mock이 single() 안에서 답변 350을 먼저 Realtime으로 배달한다.
    await typeAndSend(container, "셋째 질문");
    await waitFor(() => {
      assert.match(container.querySelector('[data-message-id="303"]')?.textContent ?? "", /셋째 질문/);
      assert.match(container.querySelector('[data-message-id="350"]')?.textContent ?? "", /선도착 답변입니다/,
        "RPC 반환 전에 선도착한 답변이 DOM에 보여야 한다");
      assert.equal(attachedThinking(container, 303), true,
        "답변 선도착(outbox 이전)이어도 전송 marker로 Q3 말풍선이 남아야 한다");
      const bubble = container.querySelector('[data-message-id="303"]')?.nextElementSibling;
      assert.equal(bubble?.getAttribute("data-pending"), "false");
      assert.equal(bubble?.querySelector('[role="status"]') == null, true, "role=status 가 남아 있다");
      const outbox = JSON.parse(dom.window.localStorage.getItem(BASEBALL_QA_OUTBOX_KEY) ?? "[]") as Array<{ messageId: number }>;
      assert.equal(outbox.some((entry) => entry.messageId === 303), false,
        "답변 선도착이면 enqueue를 건너뛰어 outbox에 303이 없어야 한다");
      assert.equal(container.querySelectorAll('[data-testid="genius-thinking-bubble"]').length, 1);
    }, act);
    console.log("✅ actual answer-before-outbox → outbox skipped + bubble retained");

    // 같은 stale localStorage를 둔 채 새 hook/page 인스턴스로 재진입한다.
    await act(async () => { root.unmount(); });
    container.replaceChildren();
    root = createRoot(container);
    await act(async () => { root.render(React.createElement(Harness, { initialConversationId: CONVERSATION_ID })); });
    await waitFor(() => assert.match(container.querySelector('[data-message-id="202"]')?.textContent ?? "", /둘째 질문/), act);
    assert.equal(container.querySelectorAll('[data-testid="genius-thinking-bubble"]').length, 0,
      "reload/re-entry에서 stale outbox로 thinking이 되살아나면 안 된다");
    console.log("✅ actual reload/re-entry with stale localStorage → thinking0");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    mutable.from = original.from; mutable.rpc = original.rpc; mutable.channel = original.channel;
    mutable.removeChannel = original.removeChannel; mutable.auth = original.auth; globalThis.fetch = original.fetch;
    dom.window.close();
  }
  console.log("✅ genius thinking workflow DOM: actual hook+page end-to-end PASS");
  process.exit(0);
}

void main().catch((error) => { console.error(error); process.exit(1); });
