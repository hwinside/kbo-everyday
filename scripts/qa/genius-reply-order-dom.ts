/** 실제 DM page DOM — 답변 역순 도착에서도 payload.question_message_id ↔ visible content exact 결속. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import type * as ReactNamespace from "react";

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "qa-anon-key";
process.env.NODE_ENV = "development";

const GENIUS_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
for (const key of ["HTMLElement", "Element", "Node", "Event", "MouseEvent"]) {
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

function assertDomBindingWiring(source: string) {
  assert.match(source, /data-message-id=\{msg\.id\}/, "visible message DOM id 결속이 필요하다");
  assert.match(
    source,
    /data-genius-question-id=\{geniusReply\?\.question_message_id\}/,
    "answer DOM은 payload의 exact 질문 id에 결속돼야 한다",
  );
}

async function main() {
  const pageSource = readFileSync("src/app/(main)/messages/[conversationId]/page.tsx", "utf8");
  assertDomBindingWiring(pageSource);
  assert.throws(
    () => assertDomBindingWiring(pageSource.replace(
      "data-genius-question-id={geniusReply?.question_message_id}",
      "data-genius-question-id={msg.id}",
    )),
    /payload의 exact 질문 id/,
    "질문 결속을 답변 id로 바꾸면 mutation이 RED여야 한다",
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

  const rows = [
    { id: 304, conversation_id: "conv", sender_id: GENIUS_ID, content: "첫 질문 exact 답변", dedup_key: "baseball-genius:201", is_read: false, created_at: "2026-08-14T00:00:04Z", payload: { type: "baseball_genius_reply", reply_kind: "answer", match_path: "dictionary", question_message_id: 201 } },
    { id: 303, conversation_id: "conv", sender_id: GENIUS_ID, content: "둘째 질문 exact 답변", dedup_key: "baseball-genius:202", is_read: false, created_at: "2026-08-14T00:00:03Z", payload: { type: "baseball_genius_reply", reply_kind: "answer", match_path: "dictionary", question_message_id: 202 } },
    { id: 202, conversation_id: "conv", sender_id: "me", content: "둘째 질문", is_read: true, created_at: "2026-08-14T00:00:02Z" },
    { id: 201, conversation_id: "conv", sender_id: "me", content: "첫 질문", is_read: true, created_at: "2026-08-14T00:00:01Z" },
  ];
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
  mutable.channel = () => { const channel = { on: () => channel, subscribe: () => channel }; return channel; };
  mutable.removeChannel = async () => "ok";
  mutable.auth = {
    getSession: async () => ({ data: { session: { user: { id: "me" }, access_token: "qa-token" } } }),
    setSession: async () => ({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  globalThis.fetch = (async () => new Response(JSON.stringify({ profile, ratings: {} }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

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
    const until = Date.now() + 1_000;
    while (!container.querySelector('[data-message-id="304"]') && Date.now() < until) {
      await act(async () => { await new Promise((resolve) => dom.window.setTimeout(resolve, 5)); });
    }
    const q1 = container.querySelector('[data-message-id="201"]');
    const q2 = container.querySelector('[data-message-id="202"]');
    const a1 = container.querySelector('[data-message-id="304"][data-genius-question-id="201"]');
    const a2 = container.querySelector('[data-message-id="303"][data-genius-question-id="202"]');
    assert.match(q1?.textContent ?? "", /첫 질문/);
    assert.match(q2?.textContent ?? "", /둘째 질문/);
    assert.match(a1?.textContent ?? "", /첫 질문 exact 답변/);
    assert.doesNotMatch(a1?.textContent ?? "", /둘째 질문 exact 답변/);
    assert.match(a2?.textContent ?? "", /둘째 질문 exact 답변/);
    assert.doesNotMatch(a2?.textContent ?? "", /첫 질문 exact 답변/);
    assert.ok(Boolean(a2 && a1 && (a2.compareDocumentPosition(a1) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING)), "역순 도착을 실제 DOM에서 재현해야 한다");
    console.log("✅ 역순 답변 actual DM DOM exact 결속 PASS");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    mutable.from = original.from; mutable.channel = original.channel; mutable.removeChannel = original.removeChannel; mutable.auth = original.auth; globalThis.fetch = original.fetch;
    dom.window.close();
  }
}

void main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
