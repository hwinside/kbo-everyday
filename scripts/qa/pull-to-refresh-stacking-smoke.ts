/**
 * PullToRefresh 인디케이터 stacking 회귀 (삼순 #939 NO-GO).
 *
 * 배경: #917에서 홈 헤더 sticky z-30, 경기상세 GameDetailHeader sticky z-[100]로 바뀌며
 * in-flow 인디케이터를 헤더가 덮음. 1차 수정(z-[60])은 홈(z-30)은 살렸으나
 * 경기상세(z-[100])는 여전히 덮여 새 회귀 → 인디케이터를 z-[105]로 상향.
 *
 * 계약: 인디케이터 z는 (모든 페이지 sticky 헤더 z) < 인디케이터 < (전체화면 모달/오버레이 z).
 *   - 홈 헤더 z-30, 경기상세 헤더 z-[100]  → 인디케이터가 위
 *   - 전체화면 모달 z-[110~130], 풀스크린 뷰어 z-[10000]+ → 인디케이터가 아래
 *
 * 실행: npx tsx scripts/qa/pull-to-refresh-stacking-smoke.ts
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import PullToRefresh, {
  PTR_INDICATOR_Z,
  PTR_MAX_STICKY_HEADER_Z,
  PTR_MIN_FULLSCREEN_OVERLAY_Z,
} from "../../src/components/PullToRefresh";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

// ── 1. z 계약 불변식 ──────────────────────────────────────────
ok(
  `인디케이터 z(${PTR_INDICATOR_Z}) > sticky 헤더 상한(${PTR_MAX_STICKY_HEADER_Z})`,
  PTR_INDICATOR_Z > PTR_MAX_STICKY_HEADER_Z,
);
ok(
  `인디케이터 z(${PTR_INDICATOR_Z}) < 전체화면 오버레이 하한(${PTR_MIN_FULLSCREEN_OVERLAY_Z})`,
  PTR_INDICATOR_Z < PTR_MIN_FULLSCREEN_OVERLAY_Z,
);
ok("sticky 헤더 상한 < 전체화면 오버레이 하한(계약 일관)", PTR_MAX_STICKY_HEADER_Z < PTR_MIN_FULLSCREEN_OVERLAY_Z);

// ── 2. 실제 사용처 헤더 z가 계약 상한 이내인지(소스 스캔) ─────────
function readSrc(p: string): string {
  return readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
}
// 홈 헤더: HomeClientShell sticky z-30
const home = readSrc("src/components/home/HomeClientShell.tsx");
ok("홈 헤더 sticky z-30 존재", /sticky[^"]*\bz-30\b/.test(home));
// 경기상세 헤더: GameDetailHeader sticky z-[100]
const gameHeader = readSrc("src/components/game/GameDetailHeader.tsx");
const gameZ = gameHeader.match(/sticky[^"]*z-\[(\d+)\]/);
ok("경기상세 헤더 sticky z-[NNN] 파싱", gameZ !== null);
if (gameZ) {
  ok(
    `경기상세 헤더 z-[${gameZ[1]}] ≤ 계약 sticky 상한(${PTR_MAX_STICKY_HEADER_Z}) → 인디케이터가 위`,
    Number(gameZ[1]) <= PTR_MAX_STICKY_HEADER_Z,
  );
}
// PullToRefresh 인디케이터가 상수 PTR_INDICATOR_Z를 실제 사용(z-[60] 하드코딩 잔존 금지)
const ptr = readSrc("src/components/PullToRefresh.tsx");
ok("인디케이터가 PTR_INDICATOR_Z 사용", /zIndex:\s*PTR_INDICATOR_Z/.test(ptr));
ok("인디케이터 fixed 오버레이(page scroll 독립)", /fixed[^"]*left-0[^"]*right-0/.test(ptr));
ok("인디케이터 z-[60] 하드코딩 잔존 없음", !/z-\[60\][^]*?transition-\[height\]/.test(ptr));
ok("인디케이터 safe-area top 유지", /top:\s*"var\(--safe-area-inset-top, env\(safe-area-inset-top/.test(ptr));

// ── 3. jsdom 실 stacking: 경기상세 헤더 아래에 인디케이터가 가려지지 않음 ──
// getComputedStyle의 z-index를 각 요소에 부여하고, "인디케이터가 경기상세 헤더보다
// 위 stacking context"인지 정수 비교로 확정(브라우저 paint 순서 근사).
const { window } = new JSDOM(`<!DOCTYPE html><body></body>`);
const doc = window.document;
const globals = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
Object.defineProperties(globalThis, {
  window: { configurable: true, value: window },
  document: { configurable: true, value: doc },
  navigator: { configurable: true, value: window.navigator },
  Element: { configurable: true, value: window.Element },
  HTMLElement: { configurable: true, value: window.HTMLElement },
  Node: { configurable: true, value: window.Node },
  Event: { configurable: true, value: window.Event },
});
globals.IS_REACT_ACT_ENVIRONMENT = true;

function layer(z: number, position = "fixed"): HTMLElement {
  const n = doc.createElement("div");
  n.setAttribute("style", `position:${position}; z-index:${z};`);
  doc.body.appendChild(n);
  return n;
}
// 경기상세: sticky 헤더 z-[100] + 그 뒤 인디케이터 z-105
const gameDetailHeaderLayer = layer(Number(gameZ ? gameZ[1] : 100), "sticky");
const indicatorLayer = layer(PTR_INDICATOR_Z, "fixed");
function zOf(el: HTMLElement): number {
  return Number(window.getComputedStyle(el).zIndex || "0");
}
ok(
  "[stacking] 인디케이터 z > 경기상세 헤더 z (헤더가 안 덮음)",
  zOf(indicatorLayer) > zOf(gameDetailHeaderLayer),
);
// 전체화면 모달(z-110)은 인디케이터를 덮어야 함(당김 중 모달 우선)
const fullscreenModal = layer(PTR_MIN_FULLSCREEN_OVERLAY_Z, "fixed");
ok(
  "[stacking] 전체화면 모달 z > 인디케이터 z (모달이 우선)",
  zOf(fullscreenModal) > zOf(indicatorLayer),
);

// ── 4. 실제 컴포넌트 touch 상태 전이: home/game/admin × safe-area 0/47 ──
// React DOM에 각 사용처의 헤더 배치를 그대로 축약해 렌더하고 실제 touch 이벤트를 보낸다.
// drag 문구 → release spinner/onRefresh 1회 → resolve 뒤 height 0 복귀를 실행형으로 고정한다.
function touchEvent(type: "touchstart" | "touchmove" | "touchend", clientY?: number): Event {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: clientY === undefined ? [] : [{ clientY }],
  });
  return event;
}

interface ConsumerCase {
  name: "home" | "game" | "admin";
  headerZ: number;
  headerInsidePtr: boolean;
  safeAreaTop: 0 | 47;
}

async function exerciseConsumer(c: ConsumerCase): Promise<void> {
  const mount = doc.createElement("div");
  doc.body.appendChild(mount);
  const root = createRoot(mount);
  let refreshCalls = 0;
  let resolveRefresh!: () => void;
  const refreshPending = new Promise<void>((resolve) => {
    resolveRefresh = resolve;
  });
  const onRefresh = async () => {
    refreshCalls++;
    await refreshPending;
  };

  const header = createElement("header", {
    key: "header",
    "data-ptr-header": c.name,
    style: { position: "sticky", zIndex: c.headerZ },
  });
  const target = createElement("div", {
    key: "target",
    "data-ptr-target": c.name,
  });
  const ptr = createElement(
    PullToRefresh,
    { onRefresh },
    c.headerInsidePtr ? createElement(Fragment, null, header, target) : target,
  );
  const tree = c.headerInsidePtr
    ? ptr
    : createElement(Fragment, null, header, ptr);

  await act(async () => {
    root.render(tree);
  });

  const targetNode = mount.querySelector(`[data-ptr-target="${c.name}"]`);
  const headerNode = mount.querySelector(`[data-ptr-header="${c.name}"]`) as HTMLElement | null;
  const container = targetNode?.parentElement;
  const indicator = container?.firstElementChild as HTMLElement | null;
  ok(`[${c.name}/${c.safeAreaTop}] 렌더 노드 존재`, Boolean(targetNode && headerNode && indicator));
  if (!targetNode || !headerNode || !indicator) {
    await act(async () => root.unmount());
    mount.remove();
    return;
  }

  // env()는 jsdom CSS parser가 보존하지 않으므로 위 소스 스캔에서 계약을 고정하고,
  // 여기서는 safe-area 0/47 양쪽 케이스의 상태 전이·stacking을 동일하게 실행한다.
  ok(
    `[${c.name}/${c.safeAreaTop}] indicator(${PTR_INDICATOR_Z}) > header(${c.headerZ})`,
    Number(indicator.style.zIndex) > zOf(headerNode),
  );

  await act(async () => {
    targetNode.dispatchEvent(touchEvent("touchstart", 100));
  });
  await act(async () => {
    targetNode.dispatchEvent(touchEvent("touchmove", 300));
  });
  ok(
    `[${c.name}/${c.safeAreaTop}] drag → 놓으면 새로고침`,
    indicator.textContent?.includes("놓으면 새로고침") === true,
  );
  ok(`[${c.name}/${c.safeAreaTop}] drag height 노출`, Number.parseFloat(indicator.style.height) >= 60);

  await act(async () => {
    targetNode.dispatchEvent(touchEvent("touchend"));
  });
  ok(`[${c.name}/${c.safeAreaTop}] release → onRefresh 1회`, refreshCalls === 1);
  ok(
    `[${c.name}/${c.safeAreaTop}] release → spinner/업데이트 중`,
    indicator.querySelector(".animate-spin") !== null
      && indicator.textContent?.includes("업데이트 중...") === true,
  );

  await act(async () => {
    resolveRefresh();
    await refreshPending;
  });
  ok(`[${c.name}/${c.safeAreaTop}] 완료 → height 0px 복귀`, indicator.style.height === "0px");

  await act(async () => root.unmount());
  mount.remove();
}

async function main(): Promise<void> {
  const cases: ConsumerCase[] = [
    { name: "home", headerZ: 30, headerInsidePtr: true, safeAreaTop: 0 },
    { name: "home", headerZ: 30, headerInsidePtr: true, safeAreaTop: 47 },
    { name: "game", headerZ: 100, headerInsidePtr: false, safeAreaTop: 0 },
    { name: "game", headerZ: 100, headerInsidePtr: false, safeAreaTop: 47 },
    { name: "admin", headerZ: 40, headerInsidePtr: false, safeAreaTop: 0 },
    { name: "admin", headerZ: 40, headerInsidePtr: false, safeAreaTop: 47 },
  ];
  for (const c of cases) await exerciseConsumer(c);

  console.log(`\npull-to-refresh stacking smoke: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

void main();
