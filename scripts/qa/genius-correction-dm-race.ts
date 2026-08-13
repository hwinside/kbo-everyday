/**
 * 교정 DM 선행 도착 race — **실제 `useDMChat` hook** 회귀.
 *
 * 🔴 직전 회차 결손(삼순 2026-08-13): 새 UI 게이트가 컴포넌트+outbox helper 만 태워서,
 *    정작 `useDM` 의 선행관측 ref / late-enqueue 복원이 `baseball-genius-picker:*` 만
 *    보고 있다는 걸 못 잡았다. 교정 DM 이 질문 INSERT 응답보다 **먼저** 오면
 *    복원이 안 돌아 outbox 가 active 로 재생성되고 202 재시도·typing 이 반복된다.
 *
 * 그래서 여기서는 helper 가 아니라 **실제 hook 을 렌더**하고 send RPC 를 pending 으로 잡아
 * 그 사이에 교정 DM realtime payload 를 흘려보내는, 실제 사고 순서 그대로를 재현한다.
 *
 * 닫는 축:
 *   R1 교정 DM 선행 → outbox 가 active 로 재생성되지 않는다(재전송 0)
 *   R2 교정 DM 선행 → 카드가 typing/재시도 상태로 남지 않는다
 *   R3 picker DM 선행도 동일(기존 계약 무회귀)
 *   R4 최종 답변 DM 선행 → outbox 자체가 비고 재전송 0(기존 계약 무회귀)
 *   R5 정상 순서(응답 먼저, DM 나중)에서는 정상적으로 1회 전송된다(게이트 자체 검증력)
 */
import { JSDOM } from "jsdom";
import type * as ReactNamespace from "react";

// ⚠️ React 의 `act` 는 **development 번들에만** 있다(react package.json 조건부 exports).
// Vercel prebuild 는 NODE_ENV=production 이라 production 번들이 로드돼
// `TypeError: act is not a function` 으로 죽는다.
// 이 함정은 2026-08-03 `next-game-date-badge-render`, 그 다음 `genius-picker-disabled-render`
// 가 이미 당했고, 이 파일이 세 번째다 — 로컬에서만 통과하는 게이트는 게이트가 아니다.
//
// react/react-dom 은 아래에서 **dynamic import** 하므로(정적 import 는 hoisting 돼 이 줄보다
// 먼저 평가된다) 이 시점 세팅이 조건부 export 해석에 반영된다.
process.env.NODE_ENV = "development";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
for (const key of ["HTMLElement", "Element", "Node", "Event"]) {
  globals[key] = (dom.window as unknown as Record<string, unknown>)[key];
}
const raf = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16);
globals.requestAnimationFrame = raf;
globals.cancelAnimationFrame = (id: unknown) => clearTimeout(id as NodeJS.Timeout);
// react-dom 이 act(...) 를 지원하도록 표시 — 없으면 상태 업데이트가 flush 되지 않아
// "재전송 0" 이 가짜로 관측된다(게이트가 아무것도 안 태우고 GREEN).
globals.IS_REACT_ACT_ENVIRONMENT = true;
(dom.window as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(dom.window.document, "visibilityState", {
  get: () => "visible", configurable: true,
});
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "qa-anon-key";

let pass = 0;
const failures: string[] = [];
function check(name: string, condition: boolean, hint = "") {
  if (condition) { pass += 1; console.log(`  ✅ ${name}`); }
  else { failures.push(name); console.error(`  ❌ ${name}${hint ? `: ${hint}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 1_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (cond()) return true;
    await sleep(5);
  }
  return cond();
}

type MessageRow = {
  id: number; conversation_id: string; sender_id: string | null; content: string;
  is_read: boolean; created_at: string; dedup_key?: string | null; payload?: unknown;
};

async function main() {
  const React = (await import("react")) as typeof ReactNamespace;
  const { act } = await import("react");
  // 위 NODE_ENV 고정이 깨지면 여기서 **명시적으로** 죽는다 — 원인 불명 TypeError 대신
  // 무엇이 잘못됐는지 말해주는 실패로 만든다.
  if (typeof act !== "function") {
    throw new Error("React.act 가 없다 — development 번들이 로드되지 않았다(NODE_ENV 고정이 import 보다 늦은지 확인)");
  }
  const { createRoot } = await import("react-dom/client");
  const { supabase } = await import("../../src/lib/supabase/client");
  const { AuthProvider } = await import("../../src/lib/supabase/AuthContext");
  const { BASEBALL_GENIUS_USER_ID } = await import("../../src/lib/constants/baseball-genius");
  const { readBaseballQaOutbox, BASEBALL_QA_OUTBOX_KEY } =
    await import("../../src/lib/baseball-qa/client-outbox");

  const CONV = "conv-1";
  const QUESTION_ID = 4242;

  // ── supabase 목: 조회/실시간/RPC 를 손으로 제어한다 ─────────────────────────
  let payloadCallback: ((p: { new: MessageRow }) => void) | null = null;
  let statusCallback: ((s: string) => void) | null = null;
  let pendingSend: ((v: {
    data: { conversation_id: string; message_id: number } | null; error: null;
  }) => void) | null = null;

  const mutable = supabase as unknown as {
    from: (t: string) => unknown; channel: (n: string) => unknown;
    removeChannel: (c: unknown) => Promise<string>; rpc: (fn: string, a: unknown) => unknown;
    auth: unknown;
  };
  mutable.from = (table: string) => {
    if (table === "profiles") {
      // 프로필을 null 로 주면 AuthContext 가 1초마다 재시도하며 잡음을 만든다.
      const q = {
        select: () => q, eq: () => q,
        maybeSingle: async () => ({ data: { id: "me", nickname: "나", team_id: 1 }, error: null }),
      };
      return q;
    }
    const q = {
      select: () => q,
      update: () => {
        const u = { eq: () => u, or: () => u, then: (f?: (v: { data: null }) => void) => { f?.({ data: null }); } };
        return u;
      },
      eq: () => q, order: () => q,
      limit: async () => ({ data: [] as MessageRow[] }),
    };
    return q;
  };
  mutable.channel = (name: string) => {
    const channel = {
      id: name,
      on: (_k: string, _f: unknown, cb: (p: { new: MessageRow }) => void) => {
        payloadCallback = cb; return channel;
      },
      subscribe: (cb: (s: string) => void) => { statusCallback = cb; return channel; },
    };
    return channel;
  };
  mutable.removeChannel = async () => "ok";
  mutable.rpc = () => ({
    single: () => new Promise<{
      data: { conversation_id: string; message_id: number } | null; error: null;
    }>((resolve) => { pendingSend = resolve; }),
  });
  mutable.auth = {
    getSession: async () => ({ data: { session: { user: { id: "me" }, access_token: "t" } } }),
    setSession: async () => ({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  };

  // 전송 시도를 센다 — "재전송 0" 은 **질문 재처리 엔드포인트 호출 수**로만 증명된다.
  // (AuthContext/notify-admin 등 다른 fetch 가 섮이면 분모가 오염된다)
  const sentBodies: Record<string, unknown>[] = [];
  globals.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/baseball-qa")) {
      sentBodies.push(JSON.parse(String(init?.body ?? "{}")));
      // 200 = 서버가 처리를 마쳤다 — 정상 경로가 무한 재전송하지 않도록 닫는다.
      return { ok: true, status: 200, json: async () => ({ status: "completed" }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;

  const { useDMChat } = await import("../../src/lib/supabase/useDM");

  function geniusDm(dedupKey: string, replyKind: string): MessageRow {
    return {
      id: 90000 + Math.floor(Math.random() * 1000),
      conversation_id: CONV,
      sender_id: BASEBALL_GENIUS_USER_ID,
      content: "카드",
      is_read: false,
      created_at: "2026-08-13T00:00:00Z",
      dedup_key: dedupKey,
      payload: { type: "baseball_genius_reply", reply_kind: replyKind, question_message_id: QUESTION_ID },
    };
  }

  type Harness = { send: () => void };
  const harnessRef: { current: Harness | null } = { current: null };
  function HarnessComponent() {
    const dm = useDMChat(CONV);
    harnessRef.current = {
      // 실제 시그니처: (content, imageUrls?, targetUserIdOverride?)
      send: () => { void dm.sendMessage("보끄가모야", undefined, BASEBALL_GENIUS_USER_ID); },
    };
    return React.createElement("output", null, JSON.stringify(dm.geniusReplyStates));
  }

  /**
   * 실제 사고 순서를 재현한다:
   *   ① 유저가 질문 전송 → send RPC 가 **아직 pending**
   *   ② 서버가 이미 처리해서 카드 DM 이 realtime 으로 **먼저** 도착
   *   ③ 그제서야 send RPC 가 resolve → 여기서 late-enqueue 복원이 돌아야 한다
   */
  async function runRace(dedupKey: string | null, replyKind: string) {
    dom.window.localStorage.removeItem(BASEBALL_QA_OUTBOX_KEY);
    sentBodies.length = 0;
    payloadCallback = null; statusCallback = null; pendingSend = null;

    const host = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(host);
    const root = createRoot(host);
    // AuthProvider 없이 렌더하면 `user` 가 null 이라 sendMessage 가 즉시 return 한다 —
    // 그러면 "재전송 0" 이 전부 가짜로 GREEN 이 된다. R5 가 그걸 잡는다.
    await act(async () => {
      root.render(React.createElement(AuthProvider, null, React.createElement(HarnessComponent)));
    });
    await waitFor(() => statusCallback !== null, 3_000);
    await waitFor(() => harnessRef.current !== null, 3_000);
    await act(async () => { statusCallback?.("SUBSCRIBED"); });

    // ① 질문 전송 시작 (RPC pending)
    await act(async () => { harnessRef.current?.send(); });
    await waitFor(() => pendingSend !== null);

    // ② 카드 DM 이 먼저 도착
    if (dedupKey) {
      await act(async () => { payloadCallback?.({ new: geniusDm(dedupKey, replyKind) }); });
      await sleep(20);
    }

    // ③ send RPC resolve
    await act(async () => {
      pendingSend?.({ data: { conversation_id: CONV, message_id: QUESTION_ID }, error: null });
    });
    await sleep(80);

    const outbox = readBaseballQaOutbox(dom.window.localStorage);
    const entry = outbox.find((r) => r.messageId === QUESTION_ID);
    const states = JSON.parse(host.textContent || "{}") as Record<string, string>;
    await act(async () => { root.unmount(); });
    host.remove();
    return { outbox, entry, states, requests: sentBodies.length };
  }

  // ── R1/R2 교정 DM 선행 ────────────────────────────────────────────────────
  {
    const r = await runRace(`baseball-genius-correction:${QUESTION_ID}`, "picker");
    check(
      "R1 교정 DM 선행 시 outbox 가 active 로 재생성되지 않는다",
      r.requests === 0,
      `재전송 ${r.requests}회 — 202 재시도 루프가 된다`,
    );
    check(
      "R2 교정 DM 선행 시 카드가 typing/재시도 상태로 남지 않는다",
      r.states[String(QUESTION_ID)] !== "pending" && r.states[String(QUESTION_ID)] !== "retrying",
      `state=${r.states[String(QUESTION_ID)]}`,
    );
    check(
      "R2b 교정 DM 선행 항목은 acknowledged 로 복원된다(선택 재처리용 보존)",
      r.entry?.acknowledged === true && r.entry?.awaitingPlayerPick === true,
      `entry=${JSON.stringify(r.entry)}`,
    );
  }

  // ── R3 picker DM 선행 (기존 계약 무회귀) ──────────────────────────────────
  {
    const r = await runRace(`baseball-genius-picker:${QUESTION_ID}`, "picker");
    check("R3 picker DM 선행도 재전송 0", r.requests === 0);
    check("R3b picker 항목도 acknowledged 보존", r.entry?.acknowledged === true);
  }

  // ── R4 최종 답변 DM 선행 (기존 계약 무회귀) ───────────────────────────────
  {
    const r = await runRace(`baseball-genius:${QUESTION_ID}`, "answer");
    check("R4 최종 답변 DM 선행 시 재전송 0", r.requests === 0);
    check("R4b 최종 답변 선행 시 outbox 에서 제거된다", r.entry === undefined);
  }

  // ── R5 정상 순서 — 게이트 자체 검증력 (여기가 0 이면 위 결과는 무의미) ─────
  {
    const r = await runRace(null, "");
    check(
      "R5 카드 선행이 없으면 정상적으로 1회 전송된다(게이트 검증력)",
      r.requests === 1,
      `요청 ${r.requests}회 — 게이트가 아무 것도 안 태우고 있다`,
    );
  }

  if (failures.length > 0) {
    console.error(`❌ genius correction dm race: PASS=${pass} FAIL=${failures.length}`);
    process.exit(1);
  }
  console.log(`✅ genius correction dm race: PASS=${pass} FAIL=0`);
  // AuthContext/realtime 목이 타이머·구독을 남겨 이벤트 루프가 안 비므로 명시 종료한다.
  process.exit(0);
}

// 훅이 재시도 루프에 빠지면 게이트가 조용히 매달린다 — 매달림은 통과가 아니라 실패다.
const watchdog = setTimeout(() => {
  console.error("❌ genius correction dm race: 타임아웃(60s) — 훅이 매달렸다");
  process.exit(1);
}, 60_000);
watchdog.unref?.();

main().catch((e) => { console.error("❌ genius correction dm race FAIL:", e); process.exit(1); });
