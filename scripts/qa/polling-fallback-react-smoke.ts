/**
 * DM 폴백 actual React hook 회귀.
 * - A load pending → B current → late A 결과/payload 무영향
 * - B SUBSCRIBED → late A CLOSED 뒤 healthy 유지(visibility catch-up 0)
 * - 느린 폴백 load에서 actual usePollingFallback 동시 요청 최대 1
 */
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";

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
Object.defineProperty(dom.window.document, "visibilityState", {
  get: () => "visible",
  configurable: true,
});

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "qa-anon-key";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean) {
  if (condition) pass += 1;
  else {
    fail += 1;
    console.error(`  ✗ ${name}`);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean, timeoutMs = 1_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
}

type MessageRow = {
  id: number;
  conversation_id: string;
  sender_id: null;
  content: string;
  is_read: boolean;
  created_at: string;
};
type PendingQuery = {
  conversationId: string;
  settled: boolean;
  resolve: (value: { data: MessageRow[] }) => void;
};

async function runDmHookRegression() {
  const { supabase } = await import("../../src/lib/supabase/client");
  const { useDMChat } = await import("../../src/lib/supabase/useDM");
  const pending: PendingQuery[] = [];
  const statusCallbacks = new Map<string, (status: string) => void>();
  const payloadCallbacks = new Map<string, (payload: { new: MessageRow }) => void>();
  let channelSequence = 0;

  const mutableClient = supabase as unknown as {
    from: (table: string) => unknown;
    channel: (name: string) => unknown;
    removeChannel: (channel: unknown) => Promise<string>;
  };
  mutableClient.from = (table: string) => {
    if (table !== "dm_messages") throw new Error(`unexpected table: ${table}`);
    let conversationId = "";
    const query = {
      select: () => query,
      eq: (column: string, value: string) => {
        if (column === "conversation_id") conversationId = value;
        return query;
      },
      order: () => query,
      limit: () =>
        new Promise<{ data: MessageRow[] }>((resolve) => {
          pending.push({ conversationId, settled: false, resolve });
        }),
    };
    return query;
  };
  mutableClient.channel = () => {
    const id = String.fromCharCode(65 + channelSequence++);
    const channel = {
      id,
      on: (
        _kind: string,
        _filter: unknown,
        callback: (payload: { new: MessageRow }) => void,
      ) => {
        payloadCallbacks.set(id, callback);
        return channel;
      },
      subscribe: (callback: (status: string) => void) => {
        statusCallbacks.set(id, callback);
        return channel;
      },
    };
    return channel;
  };
  mutableClient.removeChannel = async () => "ok";

  function Harness({ conversationId }: { conversationId: string }) {
    const { messages } = useDMChat(conversationId);
    return React.createElement(
      "output",
      null,
      messages.map((message) => `${message.conversation_id}:${message.id}`).join(","),
    );
  }

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(Harness, { conversationId: "A" }));
  await waitFor(() => pending.some((query) => query.conversationId === "A"));

  root.render(React.createElement(Harness, { conversationId: "B" }));
  await waitFor(() => pending.some((query) => query.conversationId === "B"));
  const b = pending.find((query) => query.conversationId === "B");
  b!.settled = true;
  b!.resolve({
    data: [{
      id: 2,
      conversation_id: "B",
      sender_id: null,
      content: "B",
      is_read: false,
      created_at: "2026-07-30T00:00:02Z",
    }],
  });
  await waitFor(() => container.textContent === "B:2");
  check("actual useDMChat: B 응답이 현재 화면에 반영", container.textContent === "B:2");

  const a = pending.find((query) => query.conversationId === "A");
  a!.settled = true;
  a!.resolve({
    data: [{
      id: 1,
      conversation_id: "A",
      sender_id: null,
      content: "A",
      is_read: false,
      created_at: "2026-07-30T00:00:01Z",
    }],
  });
  await sleep(20);
  check("actual useDMChat: late A load가 B를 덮지 않음", container.textContent === "B:2");

  payloadCallbacks.get("A")?.({
    new: {
      id: 3,
      conversation_id: "A",
      sender_id: null,
      content: "late-A",
      is_read: false,
      created_at: "2026-07-30T00:00:03Z",
    },
  });
  await sleep(10);
  check("actual useDMChat: late A payload 무영향", container.textContent === "B:2");

  statusCallbacks.get("B")?.("SUBSCRIBED");
  await sleep(10);
  statusCallbacks.get("A")?.("CLOSED");
  await sleep(10);
  const beforeVisibility = pending.filter((query) => query.conversationId === "B").length;
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await sleep(20);
  const afterVisibility = pending.filter((query) => query.conversationId === "B").length;
  check(
    "actual useDMChat: late A CLOSED 뒤 B healthy 유지·catch-up 0",
    beforeVisibility === afterVisibility,
  );

  root.unmount();
  container.remove();
}

async function runPollingHookRegression() {
  const { usePollingFallback } = await import("../../src/lib/supabase/usePollingFallback");
  const originalRandom = Math.random;
  Math.random = () => 0;
  let calls = 0;
  let active = 0;
  let maxConcurrent = 0;
  const resolvers: Array<() => void> = [];

  function Harness({ healthy }: { healthy: boolean }) {
    const load = React.useCallback(
      () =>
        new Promise<void>((resolve) => {
          calls += 1;
          active += 1;
          maxConcurrent = Math.max(maxConcurrent, active);
          resolvers.push(() => {
            active -= 1;
            resolve();
          });
        }),
      [],
    );
    usePollingFallback(load, { enabled: true, healthy, intervalMs: 10 });
    return null;
  }

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root: Root = createRoot(container);
  root.render(React.createElement(Harness, { healthy: true }));
  await sleep(20);
  root.render(React.createElement(Harness, { healthy: false }));
  await waitFor(() => calls === 1);
  await sleep(40);
  check("actual usePollingFallback: 느린 요청 중 overlap 0", calls === 1 && maxConcurrent === 1);
  resolvers.shift()?.();
  await waitFor(() => calls === 2);
  check("actual usePollingFallback: settle 뒤 queued catch-up 1회", calls === 2 && active === 1);
  check("actual usePollingFallback: 동시 요청 상한 1", maxConcurrent === 1);
  root.render(React.createElement(Harness, { healthy: true }));
  await sleep(10);
  resolvers.shift()?.();
  await sleep(20);
  check("actual usePollingFallback: healthy 복구 뒤 추가 요청 0", calls === 2 && active === 0);

  root.unmount();
  container.remove();
  Math.random = originalRandom;
}

async function main() {
  await runDmHookRegression();
  await runPollingHookRegression();
  console.log(`\npolling-fallback-react: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
  process.exit(fail ? 1 : 0);
}

void main();
