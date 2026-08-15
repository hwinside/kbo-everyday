/**
 * "생각중입니다" 말풍선이 **답변 도착 후에도 대화에 남는가** — 실제 렌더로 고정.
 *
 * ⚠️ 이 게이트가 생긴 이유 (2026-08-04 하린아빠 실사용 지적 → Production 실측).
 *
 * 하린아빠: "생각중/답변중 마스코트는 안보이는거 확인하고 이야기한거야. 지금도 안보여"
 *
 * Production 전용 테스트 계정 실측(100ms 간격, 실브라우저):
 *   typing 노출 구간 +100ms ~ +500ms  → **지속 500ms**
 *   첫 측정 박스 `0x32`               → 그 사이 PNG 가 아직 로드도 안 됨
 *   답변 마스코트 등장 +700ms
 * 즉 사전 히트처럼 빠른 답변에서는 캐릭터가 **사람 눈에 안 잡힌다**(첫 진입은 캐시도 없음).
 *
 * 기존 게이트가 이걸 못 잡은 이유: `qa:genius-reply-mascot-browser` 는 DB 에 **이미 완료된**
 * 답변을 심고 렌더만 봤다. 대기 구간 자체를 재본 적이 없다.
 *
 * 해법은 최소 노출시간 타이머가 아니라 **대화 기록으로 남기기**다(하린아빠 20:27
 * "생각중입니다도 대화로 남겨. 캐릭터도 그대로 남아있게"). 지나가는 UI 가 아니라
 * 질문 바로 아래 머무르는 말풍선이므로 노출시간 문제가 사라진다.
 *
 * 그래서 여기서 고정하는 계약은 하나다:
 *   **답변이 도착해 대기 상태가 사라져도 말풍선과 thinking 마스코트가 그대로 남는다.**
 *
 * 실행: npm run qa:genius-thinking-bubble
 */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// ⚠️ React 의 `act` 는 **development 번들에만** 있다(react package.json 조건부 exports).
// Vercel prebuild 는 NODE_ENV=production 이라 production 번들이 로드돼
// `TypeError: act is not a function` 으로 죽는다 — 2026-08-03 `next-game-date-badge-render`,
// 2026-08-04 `genius-picker-disabled-render` 가 연달아 당한 함정이다.
// react 는 아래에서 **dynamic import** 하므로 이 시점 세팅이 조건부 export 해석에 반영된다.
process.env.NODE_ENV = "development";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
for (const key of ["HTMLElement", "Element", "Node", "Event", "MouseEvent"]) {
  globals[key] = (dom.window as unknown as Record<string, unknown>)[key];
}
(globals as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
    console.error(`  ❌ ${name}: ${(error as Error).message}`);
  }
}

async function main() {
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  assert.equal(
    typeof act, "function",
    "React.act 가 없다 — development 번들 미로드(NODE_ENV 고정이 import 보다 늦었는지 확인)",
  );

  // **실제 배포되는 컴포넌트**를 그대로 마운트한다. 자체 fixture 컴포넌트를 만들면
  // 컴포넌트가 깨져도 게이트가 GREEN 이 된다.
  const mod = await import("../../src/components/dm/GeniusTypingIndicator");
  const { GeniusThinkingBubble, GENIUS_THINKING_TEXT } = mod;
  const GeniusTypingIndicator = mod.default;
  const { geniusMascotSrc } = await import("../../src/lib/constants/baseball-genius");

  function render(node: React.ReactElement) {
    const host = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(node); });
    return {
      host,
      rerender(next: React.ReactElement) { act(() => { root.render(next); }); },
      cleanup() { act(() => { root.unmount(); }); host.remove(); },
    };
  }

  const readBubble = (host: HTMLElement) => {
    const bubble = host.querySelector('[data-testid="genius-thinking-bubble"]');
    const mascot = host.querySelector('[data-testid="genius-thinking-mascot"]') as HTMLImageElement | null;
    return {
      exists: Boolean(bubble),
      pending: bubble?.getAttribute("data-pending") ?? null,
      text: bubble?.textContent ?? "",
      mascotSrc: mascot?.getAttribute("src") ?? null,
      mascotState: mascot?.getAttribute("data-mascot") ?? null,
      dots: host.querySelectorAll(".animate-bounce").length,
      status: bubble?.querySelector('[role="status"]') !== null,
    };
  };

  // ── 계약 ①: 대기 중에는 말풍선 + thinking 마스코트 + 점 애니메이션 ──────────
  {
    const r = render(React.createElement(GeniusThinkingBubble, { pending: true }));
    const b = readBubble(r.host);
    check("대기 중 말풍선이 렌더된다", () => assert.equal(b.exists, true));
    check("대기 중 문구가 '생각중입니다…'", () => assert.ok(b.text.includes(GENIUS_THINKING_TEXT), b.text));
    check("대기 중 마스코트가 thinking", () => assert.equal(b.mascotState, "thinking"));
    check("대기 중 마스코트 src 가 배포 경로", () => assert.equal(b.mascotSrc, geniusMascotSrc("thinking")));
    check("대기 중 점 3개 애니메이션", () => assert.equal(b.dots, 3));
    check("대기 중 role=status 로 접근성 고지", () => assert.equal(b.status, true));
    r.cleanup();
  }

  // ── 계약 ②(핵심): **답변 도착 후에도 말풍선과 캐릭터가 남는다** ─────────────
  // 이게 이번 지시의 전부다. pending 만 false 로 바뀌고 말풍선 자체는 사라지지 않는다.
  {
    const r = render(React.createElement(GeniusThinkingBubble, { pending: true }));
    assert.equal(readBubble(r.host).exists, true, "선행 조건: 대기 중 렌더");
    r.rerender(React.createElement(GeniusThinkingBubble, { pending: false }));
    const after = readBubble(r.host);
    check("답변 도착 후에도 말풍선이 남는다", () => assert.equal(after.exists, true));
    check("답변 도착 후에도 캐릭터가 남는다", () => assert.equal(after.mascotState, "thinking"));
    check("답변 도착 후에도 문구가 남는다", () => assert.ok(after.text.includes(GENIUS_THINKING_TEXT)));
    check("답변 도착 후 점 애니메이션은 멈춘다", () => assert.equal(after.dots, 0));
    check("답변 도착 후 role=status 해제(스크린리더 반복 고지 방지)", () => assert.equal(after.status, false));
    check("pending 플래그가 화면 상태를 반영", () => assert.equal(after.pending, "false"));
    r.cleanup();
  }

  // ── 계약 ③: 세션 시퀀스를 **배포 SSOT 함수**로 직접 돌린다 ──────────────────
  //
  // ⚠️ 삼순 #1102 1차 P0-1: 종전 게이트는 `GeniusThinkingBubble` 단품만 렌더해서,
  // 페이지의 `showThinking` 을 `false` 로 바꿔 말풍선을 전부 제거해도 18/18 GREEN 이었다.
  // 규칙을 게이트가 자체 재현하는 것도 같은 함정이다.
  {
    const {
      markGeniusThinkingMessageId,
      resolveGeniusThinkingRender,
      transitionGeniusThinkingMessageId,
    } = await import("../../src/lib/baseball-qa/thinking-bubble");
    type States = Record<number, "waiting" | "retrying" | "failed">;
    const render1 = (id: number, thinkingId: number | null, states: States) =>
      resolveGeniusThinkingRender({
        isGeniusConversation: true, isMine: true, messageId: id,
        thinkingMessageId: thinkingId, replyStates: states,
      });
    const attachedTo = (messages: number[], thinkingId: number | null, states: States) =>
      messages.filter((id) => render1(id, thinkingId, states).show);

    // Q1 전송 (마커는 **전송 시점**에 찍힌다)
    let thinkingId = markGeniusThinkingMessageId(101, null);
    check("Q1 전송: 생각중이 Q1 에 붙는다", () => {
      assert.equal(thinkingId, 101);
      assert.deepEqual(attachedTo([101], thinkingId, { 101: "waiting" } as States), [101]);
    });
    check("Q1 대기 중 pending=true", () =>
      assert.equal(render1(101, thinkingId, { 101: "waiting" } as States).pending, true));

    // 첫 질문의 실제 배포 순서: useDMChat("") → send 성공 → router.replace(real id).
    thinkingId = transitionGeniusThinkingMessageId("", "conversation-101", thinkingId);
    check("draft→실제 대화 route 승격 뒤에도 Q1 말풍선 유지", () => {
      assert.equal(thinkingId, 101);
      assert.deepEqual(attachedTo([101], thinkingId, { 101: "waiting" } as States), [101]);
    });

    // 답변 도착 → outbox 비움. 마커는 그대로라 말풍선이 남는다.
    check("Q1 답변 도착 후에도 말풍선 유지", () => {
      assert.deepEqual(attachedTo([101, 102], thinkingId, {} as States), [101]);
    });
    check("답변 도착 후 pending=false(점 정지)", () => {
      const r = render1(101, thinkingId, {} as States);
      assert.equal(r.show, true);
      assert.equal(r.pending, false);
    });

    // ⚠️ Blocker 1 (삼순 2차): **답변이 outbox 보다 먼저** 오는 경로.
    // 이때 enqueue 가 통째로 스킵돼 outbox 는 끝까지 비어 있다. outbox 파생이었으면
    // 생각중이 한 번도 안 생겼다 — 전송 트리거라 정상 생성된다.
    check("Blocker1: 답변이 먼저 와 outbox 가 비어도 생각중이 생긴다", () => {
      const early = markGeniusThinkingMessageId(9001, null);
      assert.equal(early, 9001);
      assert.deepEqual(attachedTo([9001], early, {} as States), [9001],
        "outbox 0 인데 생각중이 안 붙었다 — outbox 파생 회귀");
      assert.equal(render1(9001, early, {} as States).pending, false);
    });

    // Q2 전송 → 생각중이 Q2 로 이동, Q1 것은 사라진다
    thinkingId = markGeniusThinkingMessageId(202, thinkingId);
    check("Q2 전송: 생각중이 최신 질문으로 이동(Q1 제거)", () => {
      assert.equal(thinkingId, 202);
      assert.deepEqual(
        attachedTo([101, 102, 202, 203], thinkingId, { 202: "waiting" } as States), [202]);
    });
    check("늦게 온 과거 전송 id 가 최신을 덮지 않는다", () =>
      assert.equal(markGeniusThinkingMessageId(101, thinkingId), 202));
    check("잘못된 id 는 무시된다", () => {
      assert.equal(markGeniusThinkingMessageId(0, thinkingId), 202);
      assert.equal(markGeniusThinkingMessageId(-1, thinkingId), 202);
      assert.equal(markGeniusThinkingMessageId(1.5, thinkingId), 202);
    });

    // ⚠️ Blocker 2 (삼순 2차): reload/재진입.
    // 새 hook 인스턴스는 prev=null 이고, 전송 행위가 없으니 마커도 없다.
    // outbox 는 localStorage 에 남아 있어도 생각중은 되살아나면 안 된다.
    check("Blocker2: reload 후 thinking 0 (stale outbox 무시)", () => {
      const fresh = transitionGeniusThinkingMessageId("conversation-101", "conversation-101", null);
      assert.deepEqual(attachedTo([101, 202, 9001], fresh, { 202: "waiting" } as States), [],
        "stale outbox 로 생각중이 되살아났다");
    });
    check("실제 대화→다른 실제 대화 전환은 marker 초기화", () => {
      assert.equal(transitionGeniusThinkingMessageId("conversation-101", "conversation-202", 202), null);
    });
    check("Blocker2: 재진입 후 다시 전송하면 그때부터 붙는다", () => {
      const afterReload = markGeniusThinkingMessageId(303, null);
      assert.equal(afterReload, 303);
      assert.deepEqual(attachedTo([202, 303], afterReload, {} as States), [303]);
    });

    // ⚠️ 실패는 pending 이 아니다 (삼순 #1102 1차 P0-2).
    check("failed 는 pending=false (재시도 버블과 충돌 방지)", () => {
      const r = render1(303, 303, { 303: "failed" } as States);
      assert.equal(r.show, true, "실패해도 생각중 기록 자체는 남는다");
      assert.equal(r.pending, false, "실패 상태에서 점 3개가 돌면 안 된다");
    });
    check("retrying 은 pending=true", () =>
      assert.equal(render1(303, 303, { 303: "retrying" } as States).pending, true));

    check("봇 대화가 아니면 안 붙는다", () => assert.equal(resolveGeniusThinkingRender({
      isGeniusConversation: false, isMine: true, messageId: 101,
      thinkingMessageId: 101, replyStates: {} as States,
    }).show, false));
    check("상대 메시지에는 안 붙는다", () => assert.equal(resolveGeniusThinkingRender({
      isGeniusConversation: true, isMine: false, messageId: 101,
      thinkingMessageId: 101, replyStates: {} as States,
    }).show, false));
  }

  // ── 계약 ④: **배포 페이지/훅이 그 SSOT 에 실제로 결속**돼 있다 ──────────────
  // 위가 전부 통과해도 페이지가 그 함수를 안 쓰면 화면엔 아무것도 안 나온다.
  // 삼순이 `showThinking=false` / `useDM marker 제거` mutation 으로 이 구멍을 재현했다.
  {
    const { readFileSync } = await import("node:fs");
    const nodePath = await import("node:path");
    const page = readFileSync(
      nodePath.join(process.cwd(), "src/app/(main)/messages/[conversationId]/page.tsx"), "utf8");
    const hook = readFileSync(nodePath.join(process.cwd(), "src/lib/supabase/useDM.ts"), "utf8");

    check("페이지가 resolveGeniusThinkingRender 를 import 한다", () =>
      assert.match(page, /import \{ resolveGeniusThinkingRender \} from "@\/lib\/baseball-qa\/thinking-bubble"/));
    check("페이지가 그 결과로 말풍선을 렌더한다(상수 무력화 불가)", () => {
      const m = page.match(/const (\w+) = resolveGeniusThinkingRender\(\{/);
      assert.ok(m, "resolveGeniusThinkingRender 호출을 찾지 못했다");
      const v = m![1];
      assert.ok(
        page.includes(`{${v}.show && <GeniusThinkingBubble pending={${v}.pending} />}`),
        `말풍선이 ${v}.show/${v}.pending 에 결속되지 않았다`,
      );
    });
    check("말풍선이 상수로 꺼져 있지 않다", () => {
      assert.ok(!/\{false && <GeniusThinkingBubble/.test(page), "말풍선이 false 로 꺼져 있다");
      assert.ok(!/GeniusThinkingBubble pending=\{(?:true|false)\}/.test(page), "pending 이 상수다");
    });
    // ⚠️ 훅이 마커를 **전송 시점에** 찍는지까지 확인한다. 이 호출이 사라지면 화면에
    // 생각중이 영영 안 뜬다(삼순 mutation 2: useDM marker 기록 제거 → 종전 GREEN).
    check("훅이 marker·route 전환 SSOT를 import 한다", () => {
      assert.match(hook, /markGeniusThinkingMessageId/);
      assert.match(hook, /transitionGeniusThinkingMessageId/);
      assert.match(hook, /from "@\/lib\/baseball-qa\/thinking-bubble"/);
    });
    check("훅이 전송 성공 직후 마커를 찍는다", () => {
      assert.match(hook, /setGeniusThinkingQuestionId\(\(prev\) =>\s*\n?\s*markGeniusThinkingMessageId\(result\.message_id as number, prev\)\)/,
        "전송 결과 message_id 로 마커를 찍는 호출이 없다");
    });
    check("마커가 enqueue 조건 **밖**에 있다(답변 선도착에도 생성)", () => {
      const markIdx = hook.indexOf("markGeniusThinkingMessageId(result.message_id");
      const guardIdx = hook.indexOf("if (!observedBaseballQaReplyIdsRef.current.has(result.message_id))");
      assert.ok(markIdx > 0 && guardIdx > 0, "마커/enqueue guard 위치를 찾지 못했다");
      assert.ok(markIdx < guardIdx,
        "마커가 enqueue guard 안에 들어가 있다 — 답변 선도착 시 생각중이 안 생긴다");
    });
    check("훅이 outbox 상태에서 마커를 파생하지 않는다(reload 부활 방지)", () => {
      assert.ok(!/selectGeniusThinkingMessageId/.test(hook),
        "outbox 파생 방식이 남아 있다 — reload 시 생각중이 되살아난다");
    });
    check("훅이 실제 conversation 전환 함수에 marker를 결속한다", () => {
      assert.match(hook, /previousConversationIdRef\.current = conversationId/);
      assert.match(hook, /transitionGeniusThinkingMessageId\(previousConversationId, conversationId, current\)/);
    });
  }

  // ── 계약 ③: 대기 인디케이터가 말풍선과 **중복 렌더되지 않는다** ─────────────
  // 종전 `GeniusTypingIndicator` 가 waiting/retrying 에서도 말풍선을 그렸다. 그대로 두면
  // 대기 중 말풍선이 두 개 뜬다. 이제 이 컴포넌트는 실패 재시도만 담당한다.
  for (const state of ["waiting", "retrying"] as const) {
    const r = render(React.createElement(GeniusTypingIndicator, { state, onRetry: () => {} }));
    check(`중복 방지: TypingIndicator(${state})는 아무것도 안 그린다`, () => {
      // ⚠️ DOM 노드를 `assert.equal(node, null)` 로 비교하면 안 된다. 실패할 때 node:assert 가
      // JSDOM 엘리먼트를 재귀 inspect 하며 **수 GB 를 먹고 SIGKILL(OOM)** 로 죽는다
      // (2026-08-15 Vercel 실측: M1 결함주입 시 8.8GB/43s → status=137 로 evidence 소실).
      // 판정은 그대로 두고 비교값만 boolean 으로 좁힌다.
      assert.equal(r.host.querySelector('[data-testid="genius-typing-indicator"]') === null, true,
        "waiting/retrying 에서 TypingIndicator 가 렌더됐다");
      assert.equal(r.host.textContent, "");
    });
    r.cleanup();
  }

  // ── 계약 ④: 실패는 여전히 재시도 UI 를 보여준다 ─────────────────────────────
  {
    let retried = 0;
    const r = render(React.createElement(GeniusTypingIndicator, {
      state: "failed", onRetry: () => { retried += 1; },
    }));
    const btn = r.host.querySelector("button");
    check("실패 시 재시도 UI 노출", () => {
      assert.notEqual(r.host.querySelector('[data-testid="genius-typing-indicator"]'), null);
      assert.notEqual(btn, null);
      assert.ok((btn?.textContent ?? "").includes("다시 시도"));
    });
    check("실패 마스코트는 unknown", () => {
      const m = r.host.querySelector('[data-testid="genius-typing-mascot"]');
      assert.equal(m?.getAttribute("data-mascot"), "unknown");
    });
    check("재시도 버튼이 콜백을 호출", () => {
      act(() => { btn?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
      assert.equal(retried, 1);
    });
    r.cleanup();
  }
  {
    const r = render(React.createElement(GeniusTypingIndicator, { state: "idle", onRetry: () => {} }));
    check("idle 은 아무것도 안 그린다", () => assert.equal(r.host.textContent, ""));
    r.cleanup();
  }

  if (failures.length > 0) {
    console.error(`\n❌ genius thinking bubble: PASS=${pass} FAIL=${failures.length}`);
    process.exit(1);
  }
  console.log(`\n✅ genius thinking bubble: ${pass} PASS (답변 도착 후 잔존 + 중복 방지 + 실패 재시도)`);
}

main().catch((error) => {
  console.error("❌ genius thinking bubble FAIL:", error);
  process.exit(1);
});
