/**
 * 야잘알봇 타이핑 인디케이터 — 실제 GeniusTypingIndicator 컴포넌트 마운트 회귀.
 *
 * 성공기준(3전이)을 가짜 geniusReplyState 로 고정한다:
 *   1. waiting  → 봇 말풍선 자리에 "답변 작성 중" 인디케이터(role=status) + bounce 점 3개 표시
 *   2. idle     → 답변 도착(실제 답변으로 교체) 시 인디케이터 제거(null)
 *   3. failed   → 오류 문구 + "다시 시도" 버튼, 클릭 시 onRetry 호출
 * prefers-reduced-motion 존중: 점에 motion-reduce:animate-none 클래스 존재.
 *
 * 실행: tsx --test scripts/qa/genius-typing-indicator-smoke.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type * as ReactNamespace from "react";
import type { Root } from "react-dom/client";

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

let React: typeof ReactNamespace;
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof ReactNamespace.act;
let GeniusTypingIndicator: typeof import("../../src/components/dm/GeniusTypingIndicator").default;
type GeniusTypingState = import("../../src/components/dm/GeniusTypingIndicator").GeniusTypingState;

test("야잘알봇 타이핑 인디케이터 3전이", async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
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

  // 전이 1: 질문 전송 직후 waiting → "답변 작성 중" 인디케이터 표시
  render("waiting");
  const waitingEl = container.querySelector('[data-testid="genius-typing-indicator"]');
  assert.ok(waitingEl, "waiting 상태에서 인디케이터가 렌더되어야 한다");
  assert.equal(waitingEl!.getAttribute("data-state"), "waiting");
  const status = container.querySelector('[role="status"]');
  assert.ok(status, "role=status 봇 말풍선이 있어야 한다");
  assert.equal(status!.getAttribute("aria-label"), "답변 작성 중");
  const dots = container.querySelectorAll(".animate-bounce");
  assert.equal(dots.length, 3, "bounce 점 3개가 있어야 한다");
  // prefers-reduced-motion 존중: 정적 fallback 클래스
  assert.ok(
    Array.from(dots).every((d) => d.className.includes("motion-reduce:animate-none")),
    "각 점에 motion-reduce:animate-none 가 있어야 한다",
  );

  // retrying 도 동일하게 인디케이터 노출(대기 계열)
  render("retrying");
  assert.ok(
    container.querySelector('[data-state="retrying"]'),
    "retrying 상태에서도 인디케이터가 유지되어야 한다",
  );

  // 전이 2: 답변 도착(ready) → idle 로 교체되면 인디케이터 제거
  render("idle");
  assert.equal(
    container.querySelector('[data-testid="genius-typing-indicator"]'),
    null,
    "idle(답변 도착) 시 인디케이터가 사라져야 한다",
  );

  // 전이 3: 실패 → 오류 + 다시 시도 버튼, 클릭 시 onRetry 호출
  render("failed");
  const failedEl = container.querySelector('[data-state="failed"]');
  assert.ok(failedEl, "failed 상태에서 오류 UI가 렌더되어야 한다");
  assert.match(failedEl!.textContent ?? "", /답변을 받지 못했어요/);
  const retryBtn = failedEl!.querySelector("button");
  assert.ok(retryBtn, "다시 시도 버튼이 있어야 한다");
  assert.equal(container.querySelector('[role="status"]'), null, "failed 시 대기 인디케이터는 없어야 한다");
  act(() => { retryBtn!.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
  assert.equal(retryCount, 1, "다시 시도 클릭 시 onRetry 가 호출되어야 한다");

  act(() => { root.unmount(); });
  console.log("✅ 야잘알봇 타이핑 인디케이터 3전이 회귀 통과");
});
