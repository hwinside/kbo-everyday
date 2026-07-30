/**
 * DM 폴백 actual React hook 회귀.
 * - A→B 전환 즉시 messages/loading reset + late A load/payload 무영향 (오발송 창 차단)
 * - sender profile await 중 A→B 전환 → late A profile resolve 가 B 를 오염 못 함
 *   (useDM post-await generation fence 삭제 시 RED — fault-injection 으로 실증)
 * - A send RPC pending 중 A→B 전환 → late A send success 가 B 화면에 A 메시지를
 *   optimistic append 못 함 (sendMessage generation fence 삭제 시 RED)
 * - 초기 replace 포함 전체 요청이 단일 request owner: 초기 load pending 중
 *   catch-up/visibility 가 겹쳐도 동시 쿼리 최대 1, 늦은 초기 응답 롤백 없음
 * - actual usePollingFallback 동시 요청 최대 1
 * - 실제 page 컴포넌트 ABA 회귀: A send pending → B → A 복귀 + 새 draft 입력 →
 *   late 최초 A success 가 새 draft 를 지우지 못함 (page 의 conversation epoch fence —
 *   id 비교로 되돌리면 RED, fault-injection 으로 실증)
 */
import { JSDOM } from "jsdom";
import type * as ReactNamespace from "react";
import type { Root } from "react-dom/client";

// react-dom 은 import 호이스팅으로 jsdom 전역 설치 전에 로드되면 이벤트 시스템이
// 비활성화된다(page 회귀의 input/click 디스패치가 묵살됨) — main() 에서 동적 로드.
let React: typeof ReactNamespace;
let createRoot: typeof import("react-dom/client").createRoot;

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
// 실제 page 렌더용 최소 polyfill — framer-motion(rAF/matchMedia)·scrollIntoView 는 jsdom 미구현.
const rafPolyfill = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16);
const cafPolyfill = (id: unknown) => clearTimeout(id as NodeJS.Timeout);
globals.requestAnimationFrame = rafPolyfill;
globals.cancelAnimationFrame = cafPolyfill;
(dom.window as unknown as Record<string, unknown>).requestAnimationFrame = rafPolyfill;
(dom.window as unknown as Record<string, unknown>).cancelAnimationFrame = cafPolyfill;
(dom.window as unknown as Record<string, unknown>).matchMedia = () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
});
(dom.window.Element.prototype as unknown as Record<string, unknown>).scrollIntoView = () => {};
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
  sender_id: string | null;
  content: string;
  is_read: boolean;
  created_at: string;
};
type PendingQuery = {
  conversationId: string;
  settled: boolean;
  resolve: (value: { data: MessageRow[] }) => void;
};
type PendingProfile = {
  senderId: string;
  settled: boolean;
  resolve: (value: { data: { nickname: string; team_id: number | null } | null }) => void;
};
type PendingRpc = {
  fn: string;
  settled: boolean;
  resolve: (value: {
    data: { conversation_id: string; message_id: number } | null;
    error: null;
  }) => void;
};

function row(id: number, conversationId: string, senderId: string | null = null): MessageRow {
  return {
    id,
    conversation_id: conversationId,
    sender_id: senderId,
    content: `m${id}`,
    is_read: false,
    created_at: `2026-07-30T00:00:0${id}Z`,
  };
}

async function runDmHookRegression() {
  const { supabase } = await import("../../src/lib/supabase/client");
  const { useDMChat } = await import("../../src/lib/supabase/useDM");
  const { AuthProvider } = await import("../../src/lib/supabase/AuthContext");
  const originalRandom = Math.random;
  Math.random = () => 0; // catch-up jitter 0ms 결정론
  const pending: PendingQuery[] = [];
  const profilePending: PendingProfile[] = [];
  const rpcPending: PendingRpc[] = [];
  let maxConcurrentQueries = 0;
  const unsettled = () => pending.filter((query) => !query.settled).length;
  const statusCallbacks = new Map<string, (status: string) => void>();
  const payloadCallbacks = new Map<string, (payload: { new: MessageRow }) => void>();

  const mutableClient = supabase as unknown as {
    from: (table: string) => unknown;
    channel: (name: string) => unknown;
    removeChannel: (channel: unknown) => Promise<string>;
    rpc: (fn: string, args: unknown) => unknown;
    auth: unknown;
  };
  mutableClient.from = (table: string) => {
    if (table === "profiles") {
      let senderId = "";
      const profileQuery = {
        select: () => profileQuery,
        eq: (_column: string, value: string) => {
          senderId = value;
          return profileQuery;
        },
        maybeSingle: () =>
          new Promise<{ data: { nickname: string; team_id: number | null } | null }>(
            (resolve) => {
              profilePending.push({ senderId, settled: false, resolve });
            },
          ),
      };
      return profileQuery;
    }
    if (table !== "dm_messages") throw new Error(`unexpected table: ${table}`);
    let conversationId = "";
    const query = {
      select: () => query,
      // 읽음 처리(update 체인)는 즉시 resolve 되는 thenable 로 흘려보낸다.
      update: () => {
        const updateQuery = {
          eq: () => updateQuery,
          or: () => updateQuery,
          then: (onFulfilled?: (value: { data: null }) => void) => {
            onFulfilled?.({ data: null });
          },
        };
        return updateQuery;
      },
      eq: (column: string, value: string) => {
        if (column === "conversation_id") conversationId = value;
        return query;
      },
      order: () => query,
      limit: () =>
        new Promise<{ data: MessageRow[] }>((resolve) => {
          pending.push({ conversationId, settled: false, resolve });
          maxConcurrentQueries = Math.max(maxConcurrentQueries, unsettled());
        }),
    };
    return query;
  };
  mutableClient.channel = (name: string) => {
    const id = name.startsWith("dm:") ? name.slice(3) : name;
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
  mutableClient.rpc = (fn: string) => ({
    single: () =>
      new Promise<{ data: { conversation_id: string; message_id: number } | null; error: null }>(
        (resolve) => {
          rpcPending.push({ fn, settled: false, resolve });
        },
      ),
  });
  // AuthProvider 용 최소 auth 목 — 실제 user 가 훅에 공급되어 sendMessage 가 동작한다.
  mutableClient.auth = {
    getSession: async () => ({
      data: { session: { user: { id: "me" }, access_token: "qa-token" } },
    }),
    setSession: async () => ({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  };

  function Harness({ conversationId }: { conversationId: string }) {
    const { messages, loading } = useDMChat(conversationId);
    return React.createElement(
      "output",
      null,
      (loading ? "L|" : "") +
        messages.map((message) => `${message.conversation_id}:${message.id}`).join(","),
    );
  }

  const resolveQuery = (conversationId: string, data: MessageRow[]) => {
    const query = pending.find((q) => q.conversationId === conversationId && !q.settled);
    if (!query) throw new Error(`no pending query for ${conversationId}`);
    query.settled = true;
    query.resolve({ data });
  };

  // ── 시나리오 1: A→B 전환 fence (blocker 2) + sender profile await RED 회귀 (blocker 3) ──
  {
    const container = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container);
    const root = createRoot(container);
    root.render(React.createElement(Harness, { conversationId: "A" }));
    await waitFor(() => pending.some((query) => query.conversationId === "A"));
    check("actual useDMChat: 초기 로드 중 loading 표시", container.textContent === "L|");
    resolveQuery("A", [row(1, "A")]);
    await waitFor(() => container.textContent === "A:1");
    check("actual useDMChat: A 초기 로드 반영", container.textContent === "A:1");

    // sender_id 있는 A payload → profile fetch 가 실제로 시작·pending
    payloadCallbacks.get("A")?.({ new: row(3, "A", "u1") });
    await waitFor(() => profilePending.some((profile) => profile.senderId === "u1"));
    check(
      "actual useDMChat: sender payload 가 profile await 를 실제 실행",
      profilePending.some((profile) => profile.senderId === "u1" && !profile.settled),
    );

    // A 화면이 보이는 상태에서 B 로 전환 → 즉시 reset (A 잔존 화면 오발송 창 차단)
    root.render(React.createElement(Harness, { conversationId: "B" }));
    await waitFor(() => container.textContent === "L|");
    check("actual useDMChat: B 전환 즉시 messages 비움 + loading 전환", container.textContent === "L|");
    await waitFor(() => pending.some((query) => query.conversationId === "B"));

    // late A profile resolve → post-await fence 로 폐기 (fence 삭제 시 A:3 이 붙어 RED)
    const profile = profilePending.find((p) => p.senderId === "u1")!;
    profile.settled = true;
    profile.resolve({ data: { nickname: "에이", team_id: 1 } });
    await sleep(30);
    check(
      "actual useDMChat: late A profile resolve 가 B 를 오염하지 않음 (post-await fence)",
      container.textContent === "L|",
    );

    // B load 지연/실패해도 A 메시지는 이미 비워져 있음 → 빈 data 로 resolve
    resolveQuery("B", [row(2, "B")]);
    await waitFor(() => container.textContent === "B:2");
    check("actual useDMChat: B 응답이 현재 화면에 반영", container.textContent === "B:2");

    // late A payload (sender 없음) → conversation fence 로 폐기
    payloadCallbacks.get("A")?.({ new: row(4, "A") });
    await sleep(10);
    check("actual useDMChat: late A payload 무영향", container.textContent === "B:2");

    statusCallbacks.get("B")?.("SUBSCRIBED");
    await sleep(10);
    statusCallbacks.get("A")?.("CLOSED");
    await sleep(10);
    const beforeVisibility = pending.length;
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await sleep(20);
    check(
      "actual useDMChat: late A CLOSED 뒤 B healthy 유지·catch-up 0",
      pending.length === beforeVisibility,
    );

    root.unmount();
    container.remove();
  }

  // ── 시나리오 2: 초기 replace 포함 단일 request owner (blocker 1) ──
  {
    maxConcurrentQueries = 0;
    const container = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container);
    const root = createRoot(container);
    root.render(React.createElement(Harness, { conversationId: "C" }));
    await waitFor(() => pending.some((query) => query.conversationId === "C"));

    // 초기 replace pending 중 구독 사망(catch-up jitter 0ms) + visibility 복귀가 겹침
    statusCallbacks.get("C")?.("SUBSCRIBED");
    await sleep(10);
    statusCallbacks.get("C")?.("CLOSED");
    await sleep(30);
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await sleep(30);
    check(
      "actual useDMChat: 초기 load pending 중 catch-up/visibility 겹쳐도 동시 쿼리 1",
      unsettled() === 1 && maxConcurrentQueries === 1,
    );

    // 초기 응답이 settle 된 뒤에야 queued 폴백이 정확히 1회 이어서 실행
    resolveQuery("C", [row(1, "C")]);
    await waitFor(() => pending.filter((query) => query.conversationId === "C").length === 2);
    check("actual useDMChat: settle 뒤 queued 폴백 1회", unsettled() === 1);
    check("actual useDMChat: 전체 경로 동시 요청 상한 1", maxConcurrentQueries === 1);

    // 폴백이 더 새로운 데이터를 merge — 늦은 초기 응답이 최신 상태를 되돌릴 수 없음
    resolveQuery("C", [row(1, "C"), row(2, "C")]);
    await waitFor(() => container.textContent === "C:1,C:2");
    check("actual useDMChat: 최신 데이터 유지(늦은 초기 롤백 없음)", container.textContent === "C:1,C:2");
    await sleep(30);
    check("actual useDMChat: 추가 쿼리 발화 없음", unsettled() === 0);

    root.unmount();
    container.remove();
  }

  // ── 시나리오 3: A send RPC pending → B 전환 → late A success 가 B 를 오염 못 함 (왕10 3/3 blocker) ──
  {
    type SendFn = (
      content: string,
      imageUrls?: string[],
      targetUserIdOverride?: string,
    ) => Promise<{ ok: boolean; conversationId: string | null }>;
    const sendRef: { current: SendFn | null } = { current: null };

    function SendHarness({ conversationId }: { conversationId: string }) {
      const { messages, loading, sendMessage } = useDMChat(conversationId);
      React.useEffect(() => {
        sendRef.current = sendMessage;
      }, [sendMessage]);
      return React.createElement(
        "output",
        null,
        (loading ? "L|" : "") +
          messages.map((message) => `${message.conversation_id}:${message.id}`).join(","),
      );
    }

    const container = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container);
    const root = createRoot(container);
    const render = (conversationId: string) =>
      root.render(
        React.createElement(
          AuthProvider,
          null,
          React.createElement(SendHarness, { conversationId }),
        ),
      );

    render("A");
    await waitFor(() => pending.some((query) => query.conversationId === "A" && !query.settled));
    resolveQuery("A", [row(1, "A")]);
    await waitFor(() => container.textContent === "A:1");
    check("actual useDMChat: send 시나리오 A 초기 로드", container.textContent === "A:1");
    await waitFor(() => sendRef.current !== null);

    // A 에서 send 시작 — RPC 는 pending 으로 묶어둔다 (override 로 대상 조회 생략).
    const sendPromise = sendRef.current!("늦은 A 전송", [], "u2");
    await waitFor(() => rpcPending.some((rpc) => !rpc.settled));
    check(
      "actual useDMChat: send RPC 가 실제로 pending",
      rpcPending.some((rpc) => rpc.fn === "send_dm_message_atomic" && !rpc.settled),
    );

    // RPC pending 상태에서 B 로 전환 → 즉시 reset, B 는 빈 대화.
    render("B");
    await waitFor(() => container.textContent === "L|");
    await waitFor(() => pending.some((query) => query.conversationId === "B" && !query.settled));
    resolveQuery("B", []);
    await waitFor(() => container.textContent === "");
    check("actual useDMChat: B 전환 후 빈 대화 표시", container.textContent === "");

    // 늦은 A send success — fence 가 없으면 A:9 가 B 화면에 붙고 빈 B 에서 계속 남는다.
    const rpc = rpcPending.find((entry) => !entry.settled)!;
    rpc.settled = true;
    rpc.resolve({ data: { conversation_id: "A", message_id: 9 }, error: null });
    const sendResult = await sendPromise;
    await sleep(30);
    check(
      "actual useDMChat: late A send success 가 B 메시지 상태를 오염하지 않음 (send generation fence)",
      container.textContent === "",
    );
    check(
      "actual useDMChat: fence 는 상태만 폐기 — 서버 성공 결과는 그대로 반환",
      sendResult.ok === true && sendResult.conversationId === "A",
    );

    root.unmount();
    container.remove();
  }

  Math.random = originalRandom;
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

// 실제 DM page 컴포넌트 ABA 회귀 (왕복 4 blocker) — A send pending 중 A→B→A 복귀 후
// 새 draft 를 입력해도, 늦게 도착한 최초 A send 결과가 composer(새 draft)를 지우지 못한다.
// id 비교 fence 는 둘 다 A 라 통과시키므로 이 회귀는 monotonic epoch fence 에만 GREEN.
async function runPageAbaRegression() {
  const { supabase } = await import("../../src/lib/supabase/client");
  const { AuthProvider } = await import("../../src/lib/supabase/AuthContext");
  const { AppRouterContext } = await import(
    "next/dist/shared/lib/app-router-context.shared-runtime"
  );
  const { PathParamsContext } = await import(
    "next/dist/shared/lib/hooks-client-context.shared-runtime"
  );
  const DMChatPage = (await import("../../src/app/(main)/messages/[conversationId]/page")).default;

  const originalRandom = Math.random;
  Math.random = () => 0;
  const pending: PendingQuery[] = [];
  const rpcPending: PendingRpc[] = [];

  const mutableClient = supabase as unknown as {
    from: (table: string) => unknown;
    channel: (name: string) => unknown;
    removeChannel: (channel: unknown) => Promise<string>;
    rpc: (fn: string, args: unknown) => unknown;
    auth: unknown;
  };
  mutableClient.from = (table: string) => {
    if (table === "dm_conversations") {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: { user1_id: "me", user2_id: "u2" } }),
      };
      return query;
    }
    if (table === "profiles") {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: { nickname: "상대", team_id: null } }),
      };
      return query;
    }
    if (table === "user_blocks") {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: null }),
      };
      return query;
    }
    if (table !== "dm_messages") throw new Error(`unexpected table: ${table}`);
    let conversationId = "";
    const query = {
      select: () => query,
      update: () => {
        const updateQuery = {
          eq: () => updateQuery,
          or: () => updateQuery,
          then: (onFulfilled?: (value: { data: null }) => void) => {
            onFulfilled?.({ data: null });
          },
        };
        return updateQuery;
      },
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
    const channel = {
      on: () => channel,
      subscribe: () => channel,
    };
    return channel;
  };
  mutableClient.removeChannel = async () => "ok";
  mutableClient.rpc = (fn: string) => ({
    single: () =>
      new Promise<{ data: { conversation_id: string; message_id: number } | null; error: null }>(
        (resolve) => {
          rpcPending.push({ fn, settled: false, resolve });
        },
      ),
  });
  mutableClient.auth = {
    getSession: async () => ({
      data: { session: { user: { id: "me" }, access_token: "qa-token" } },
    }),
    setSession: async () => ({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  };

  const resolveQuery = (conversationId: string, data: MessageRow[]) => {
    const query = pending.find((q) => q.conversationId === conversationId && !q.settled);
    if (!query) throw new Error(`no pending query for ${conversationId}`);
    query.settled = true;
    query.resolve({ data });
  };

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const router = {
    back: () => {},
    forward: () => {},
    refresh: () => {},
    push: () => {},
    replace: () => {},
    prefetch: () => {},
    hmrRefresh: () => {},
  };
  const renderPage = (conversationId: string) =>
    root.render(
      React.createElement(
        AppRouterContext.Provider,
        { value: router as never },
        React.createElement(
          PathParamsContext.Provider,
          { value: { conversationId } },
          React.createElement(AuthProvider, null, React.createElement(DMChatPage)),
        ),
      ),
    );

  const composer = () => container.querySelector("textarea") as HTMLTextAreaElement | null;
  const valueSetter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  const typeDraft = (value: string) => {
    const el = composer()!;
    valueSetter.call(el, value);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const clickSend = () => {
    container
      .querySelector('button[aria-label="쪽지 보내기"]')!
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  };

  // A 진입 → 빈 대화 로드 완료 → composer 활성
  renderPage("A");
  await waitFor(() => pending.some((q) => q.conversationId === "A" && !q.settled));
  resolveQuery("A", []);
  await waitFor(() => composer() !== null);
  check("actual page: A 진입 후 composer 렌더", composer() !== null);

  // A 에서 최초 전송 시작 — RPC 는 pending 으로 묶어둔다.
  typeDraft("최초 A 전송");
  await waitFor(() => composer()?.value === "최초 A 전송");
  clickSend();
  await waitFor(() => rpcPending.some((rpc) => !rpc.settled));
  check(
    "actual page: 최초 A send RPC 가 실제로 pending",
    rpcPending.some((rpc) => rpc.fn === "send_dm_message_atomic" && !rpc.settled),
  );

  // B 전환 → 다시 A 복귀 (ABA) — id 만 비교하는 fence 는 이 복귀를 구분 못 한다.
  renderPage("B");
  await waitFor(() => pending.some((q) => q.conversationId === "B" && !q.settled));
  resolveQuery("B", []);
  await waitFor(() => composer() !== null && composer()!.value === "");
  renderPage("A");
  await waitFor(() => pending.some((q) => q.conversationId === "A" && !q.settled));
  resolveQuery("A", []);
  await waitFor(() => composer() !== null);

  // A 복귀 후 새 draft 입력 → 늦은 최초 A success 도착.
  typeDraft("새 A draft");
  await waitFor(() => composer()?.value === "새 A draft");
  const rpc = rpcPending.find((entry) => !entry.settled)!;
  rpc.settled = true;
  rpc.resolve({ data: { conversation_id: "A", message_id: 9 }, error: null });
  await sleep(50);

  check(
    "actual page ABA: late 최초 A success 가 새 draft 를 지우지 않음 (epoch fence)",
    composer()?.value === "새 A draft",
  );
  const sendButton = container.querySelector(
    'button[aria-label="쪽지 보내기"]',
  ) as HTMLButtonElement;
  check("actual page ABA: composer 재전송 가능 (sending 잠김 없음)", sendButton.disabled === false);
  check(
    "actual page ABA: 과거 전송 결과가 error 배너를 띄우지 않음",
    container.querySelector('[role="alert"]') === null,
  );

  root.unmount();
  container.remove();
  Math.random = originalRandom;
}

async function main() {
  React = (await import("react")).default;
  ({ createRoot } = await import("react-dom/client"));
  await runDmHookRegression();
  await runPollingHookRegression();
  await runPageAbaRegression();
  console.log(`\npolling-fallback-react: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
  process.exit(fail ? 1 : 0);
}

void main();
