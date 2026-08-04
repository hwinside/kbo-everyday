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

  // ── 계약 ③: 대기 인디케이터가 말풍선과 **중복 렌더되지 않는다** ─────────────
  // 종전 `GeniusTypingIndicator` 가 waiting/retrying 에서도 말풍선을 그렸다. 그대로 두면
  // 대기 중 말풍선이 두 개 뜬다. 이제 이 컴포넌트는 실패 재시도만 담당한다.
  for (const state of ["waiting", "retrying"] as const) {
    const r = render(React.createElement(GeniusTypingIndicator, { state, onRetry: () => {} }));
    check(`중복 방지: TypingIndicator(${state})는 아무것도 안 그린다`, () => {
      assert.equal(r.host.querySelector('[data-testid="genius-typing-indicator"]'), null);
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
