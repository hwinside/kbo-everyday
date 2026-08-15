/**
 * 야잘알봇 마스코트 모션 게이트 (SSOT §7.6 — 2026-08-15 하린아빠 착수 지시).
 *
 * 계약:
 *  ① 매핑: 인사→excited(신남) / 감사·칭찬→headspin(헤드스핀) / 결정론 거절(scope_guide·blocked)→bored(심심함).
 *     되묻기·오류·지식 답변에는 모션 없음. 판정은 **answerQuestion 실실행**으로 본다(문자열 검사 금지).
 *  ② payload: composeGeniusReplyPayload 실행으로 motion 이 실리는지 / 비모션 경로에 키 자체가 없는지.
 *  ③ 폐쇄집합: geniusMotionFromPayload 는 3종 밖 값(미래 서버·조작)을 null 로 — payload 전체는 살아있어야 한다.
 *  ④ 최신 1개만 (하린아빠 13:34 "이전에 보여줬던 모션은 새로운 모션이 등장하면 사라져야 함"
 *     + 13:53 "이전 답변은 정적 마스코트도 안되고 아예 마스코트가 없어야 함"):
 *     실제 DMChatPage 마운트 + 실제 Realtime callback 배달로 **마스코트 자체가 항상 정확히
 *     1개**(최신 봇 답변), 이전 답변은 마스코트 없이 닉네임만 남는지 DOM 으로 검증.
 *
 * 실행: npm run qa:genius-mascot-motion
 */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type * as ReactNamespace from "react";
import type { Root } from "react-dom/client";

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "***";
process.env.NODE_ENV = "development";

let pass = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name);
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function partPipeline() {
  const pipeline = await import("../../src/lib/baseball-qa/pipeline");
  const { answerQuestion, isGreetingPhrase, isAckPhrase, isScopeAskPhrase } = pipeline;
  const GREETING_Q = "안녕";
  const ACK_Q = "고마워";
  const SCOPE_Q = "야구 룰";
  check("입력 전제 (판정기 실확인)",
    isGreetingPhrase(GREETING_Q) && isAckPhrase(ACK_Q) && isScopeAskPhrase(SCOPE_Q));
  const deps = () => ({
    loadGlossary: async () => [],
    loadPlayers: async () => [],
    getCache: async () => null,
    setCache: async () => {},
    callLlm: async () => { throw new Error("llm must not be called"); },
    reserveDaily: async () => ({ allowed: true, remaining: 19 }),
    log: async () => {},
  });
  {
    const res = await answerQuestion("u1", GREETING_Q, deps() as never);
    check("실실행: 인사 → motion excited", res.source === "ack" && res.motion === "excited",
      `source=${res.source} motion=${String(res.motion)}`);
  }
  {
    const res = await answerQuestion("u1", ACK_Q, deps() as never);
    check("실실행: 감사 → motion headspin", res.source === "ack" && res.motion === "headspin",
      `source=${res.source} motion=${String(res.motion)}`);
  }
  {
    const res = await answerQuestion("u1", SCOPE_Q, deps() as never);
    check("실실행: 범위 재질문(scope_guide 거절) → motion bored",
      res.source === "scope_guide" && res.motion === "bored",
      `source=${res.source} motion=${String(res.motion)}`);
  }
}

async function partPayload() {
  const {
    composeGeniusReplyPayload, geniusMotionFromPayload, isGeniusReplyPayload,
  } = await import("../../src/lib/constants/baseball-genius");
  {
    const payload = composeGeniusReplyPayload({ source: "ack", motion: "excited" }, 42);
    check("compose: motion 이 payload 에 실린다",
      payload.motion === "excited" && payload.reply_kind === "ack" && payload.question_message_id === 42);
    check("compose 결과가 클라 validator 를 통과한다", isGeniusReplyPayload(payload));
    check("accessor: 유효 모션 → 그대로", geniusMotionFromPayload(payload) === "excited");
  }
  {
    const payload = composeGeniusReplyPayload({ source: "rag", sourceUrl: "https://namu.wiki/w/x" }, 7);
    check("compose: 비모션 경로에는 motion 키 자체가 없다",
      !("motion" in payload) && payload.reply_kind === "answer" && payload.source_url === "https://namu.wiki/w/x");
    check("accessor: motion 없음 → null", geniusMotionFromPayload(payload) === null);
  }
  {
    const payload = composeGeniusReplyPayload({
      source: "player_picker",
      pickerOptions: [{ kboId: "69100", name: "구본혁", team: "LG", position: "내야수", backNo: "2" }],
    }, 9);
    check("compose: picker 매핑 형태 보존(kbo_id·back_no)",
      payload.picker_options?.[0]?.kbo_id === "69100" && payload.picker_options?.[0]?.back_no === "2");
  }
  {
    // 미래 서버가 새 모션 값을 보내도 ①payload 는 유효해야 하고 ②모션만 없음으로 폴백한다.
    const foreign = { type: "baseball_genius_reply", reply_kind: "ack", match_path: "ack", question_message_id: 1, motion: "sparkle" };
    check("폐쇄집합: 밖의 값은 payload 를 살리고 모션만 null",
      isGeniusReplyPayload(foreign) && geniusMotionFromPayload(foreign as never) === null);
    const garbage = { ...foreign, motion: 42 };
    check("validator: motion 비문자열은 거부", !isGeniusReplyPayload(garbage));
  }
}

// ── ④ 실제 DMChatPage DOM — 최신 1개만 ──────────────────────────────────────
const GENIUS_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
const CONVERSATION_ID = "motion-conversation";

type Row = {
  id: number; conversation_id: string; sender_id: string; content: string;
  is_read: boolean; created_at: string; dedup_key?: string; payload?: Record<string, unknown>;
};

async function partDom() {
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

  const React = await import("react") as typeof ReactNamespace;
  const { createRoot } = await import("react-dom/client");
  const act = React.act;
  assert.equal(typeof act, "function");
  const { supabase } = await import("../../src/lib/supabase/client");
  const { AuthProvider } = await import("../../src/lib/supabase/AuthContext");
  const { ThemeProvider } = await import("../../src/components/ThemeProvider");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { PathParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  const DMChatPage = (await import("../../src/app/(main)/messages/[conversationId]/page")).default;

  const profile = { id: "me", nickname: "테스터", team_id: 1, favorite_players: [], points: 0, grade: "rookie", avatar_url: null, invited_by: null };
  const genius = { ...profile, id: GENIUS_ID, nickname: "야잘알봇", team_id: null };
  const rows: Row[] = [
    { id: 101, conversation_id: CONVERSATION_ID, sender_id: "me", content: "안녕", is_read: true, created_at: "2026-08-15T00:00:01Z" },
    {
      id: 150, conversation_id: CONVERSATION_ID, sender_id: GENIUS_ID, content: "만나서 반갑습니다.",
      is_read: false, created_at: "2026-08-15T00:00:02Z", dedup_key: "baseball-genius:101",
      payload: { type: "baseball_genius_reply", reply_kind: "ack", match_path: "ack", question_message_id: 101, motion: "excited" },
    },
  ];

  type RealtimePayload = { new: Row };
  const realtimeHandlers = new Map<string, (payload: RealtimePayload) => unknown>();
  const deliver = async (row: Row) => {
    rows.push(row);
    const handler = realtimeHandlers.get(`dm:${CONVERSATION_ID}`);
    assert.ok(handler, "실제 대화 Realtime 구독이 있어야 한다");
    await handler({ new: row });
  };

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
      // Realtime 단건 조회가 봇 발신자에게 유저 프로필(team_id=1)을 돌려주면 이전 봇
      // 답변이 TeamBadge fallback 을 타버린다 — eq 인자를 보고 실제처럼 분기한다.
      let requestedId: unknown = null;
      const query = {
        select: () => query,
        eq: (_column: string, value: unknown) => { requestedId = value; return query; },
        maybeSingle: async () => ({ data: requestedId === GENIUS_ID ? genius : profile, error: null }),
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
  mutable.rpc = () => { throw new Error("rpc must not be called in this scenario"); };
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

  async function waitFor(assertion: () => void, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try { assertion(); return; } catch (error) { last = error; }
      await act(async () => { await new Promise((resolve) => dom.window.setTimeout(resolve, 5)); });
    }
    throw last;
  }

  function Harness() {
    const router = React.useMemo(() => ({
      back() {}, forward() {}, refresh() {}, push() {}, prefetch() {}, hmrRefresh() {}, replace() {},
    }), []);
    return React.createElement(
      AppRouterContext.Provider, { value: router as never },
      React.createElement(
        PathParamsContext.Provider, { value: { conversationId: CONVERSATION_ID } },
        React.createElement(
          ThemeProvider, null,
          React.createElement(AuthProvider, null, React.createElement(DMChatPage)),
        ),
      ),
    );
  }

  const mascotOf = (container: HTMLElement, messageId: number) =>
    container.querySelector(`[data-message-id="${messageId}"] [data-testid="genius-reply-mascot"]`);
  const motionOf = (container: HTMLElement, messageId: number) =>
    mascotOf(container, messageId)?.getAttribute("data-motion") ?? null;
  const motionCount = (container: HTMLElement) =>
    container.querySelectorAll("[data-motion]").length;
  const mascotCount = (container: HTMLElement) =>
    container.querySelectorAll('[data-testid="genius-reply-mascot"]').length;

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root: Root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(Harness)); });
    await waitFor(() => {
      assert.equal(motionOf(container, 150), "excited", "초기 로드: 인사 답변에 excited 모션");
      assert.equal(motionCount(container), 1);
      assert.equal(mascotCount(container), 1, "마스코트는 채팅창에 정확히 1개");
    });
    check("DOM: 초기 로드 — 인사 답변 excited, 마스코트·모션 1개", true);

    await act(async () => {
      await deliver({
        id: 250, conversation_id: CONVERSATION_ID, sender_id: GENIUS_ID, content: "도움이 됐다니 기쁩니다.",
        is_read: false, created_at: "2026-08-15T00:00:04Z", dedup_key: "baseball-genius:201",
        payload: { type: "baseball_genius_reply", reply_kind: "ack", match_path: "ack", question_message_id: 201, motion: "headspin" },
      });
    });
    await waitFor(() => {
      assert.equal(motionOf(container, 250), "headspin", "새 모션이 최신 메시지에 붙는다");
      assert.equal(mascotOf(container, 150) === null, true,
        "이전 답변은 정적 마스코트도 없이 완전히 사라진다 (13:53 지시)");
      assert.equal(motionCount(container), 1, "모션은 항상 정확히 1개");
      assert.equal(mascotCount(container), 1, "마스코트 자체도 항상 정확히 1개");
      assert.match(container.querySelector('[data-message-id="150"]')?.textContent ?? "", /반갑습니다/,
        "이전 답변 본문은 그대로 남는다");
    });
    check("DOM: 새 모션 도착 → 이전 답변 마스코트 완전 제거, 최신 1개만", true);

    await act(async () => {
      await deliver({
        id: 350, conversation_id: CONVERSATION_ID, sender_id: GENIUS_ID, content: "야구 이야기만 답할 수 있습니다.",
        is_read: false, created_at: "2026-08-15T00:00:06Z", dedup_key: "baseball-genius:301",
        payload: { type: "baseball_genius_reply", reply_kind: "unavailable", match_path: "blocked", question_message_id: 301, motion: "bored" },
      });
    });
    await waitFor(() => {
      assert.equal(motionOf(container, 350), "bored");
      assert.equal(mascotOf(container, 250) === null, true, "직전 답변 마스코트 제거");
      assert.equal(motionCount(container), 1);
      assert.equal(mascotCount(container), 1);
    });
    check("DOM: 거절 bored 모션도 같은 규칙(마스코트·모션 최신 1개)", true);

    // 폐쇄집합 밖 모션 — 새 메시지가 와도 모션이 붙지 않고, 기존 최신(bored)이 유지된다.
    await act(async () => {
      await deliver({
        id: 450, conversation_id: CONVERSATION_ID, sender_id: GENIUS_ID, content: "미래 모션 값입니다.",
        is_read: false, created_at: "2026-08-15T00:00:08Z", dedup_key: "baseball-genius:401",
        payload: { type: "baseball_genius_reply", reply_kind: "ack", match_path: "ack", question_message_id: 401, motion: "sparkle" },
      });
    });
    await waitFor(() => {
      assert.ok(container.querySelector('[data-message-id="450"]'), "미지 모션 메시지도 본문은 렌더된다");
      // 최신 봇 답변이므로 마스코트는 붙되, 폐쇄집합 밖 모션 값은 정적으로 강등된다.
      assert.equal(mascotOf(container, 450) !== null, true, "최신 답변엔 마스코트가 붙는다");
      assert.equal(motionOf(container, 450), null, "폐쇄집합 밖 값은 모션 없음(정적)");
      assert.equal(mascotOf(container, 350) === null, true, "이전 답변 마스코트 제거");
      assert.equal(motionCount(container), 0, "유효 모션이 없으면 모션 0개");
      assert.equal(mascotCount(container), 1, "마스코트는 여전히 정확히 1개");
    });
    check("DOM: 폐쇄집합 밖 값 — 최신엔 정적 마스코트만, 이전 제거 유지", true);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    mutable.from = original.from; mutable.rpc = original.rpc; mutable.channel = original.channel;
    mutable.removeChannel = original.removeChannel; mutable.auth = original.auth; globalThis.fetch = original.fetch;
    dom.window.close();
  }
}

async function main() {
  await partPipeline();
  await partPayload();
  await partDom();
  if (failures.length > 0) {
    console.error(`\n❌ genius mascot motion FAIL: ${failures.length}건 — ${failures.join(" | ")}`);
    process.exit(1);
  }
  console.log(`\n✅ genius mascot motion: ${pass} PASS (매핑 실실행 + payload 조립 + 폐쇄집합 + 최신 1개만 DOM)`);
  process.exit(0);
}

void main().catch((error) => { console.error("❌ genius mascot motion FAIL:", error); process.exit(1); });
