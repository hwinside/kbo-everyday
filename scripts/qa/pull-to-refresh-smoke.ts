/**
 * PullToRefresh arm 게이트 회귀 (삼순 #731 NO-GO 1·2차).
 * - 순수 판정(nodeBlocksPull) + 실제 DOM 조상 워커(pullStartIsBlocked) 3경계.
 * 실행: npx tsx scripts/qa/pull-to-refresh-smoke.ts
 */
import { JSDOM } from "jsdom";
import { nodeBlocksPull, pullStartIsBlocked } from "../../src/components/PullToRefresh";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

// ── 순수 판정 ──────────────────────────────────────────────
ok("INPUT → 차단", nodeBlocksPull({ tag: "INPUT" }) === true);
ok("TEXTAREA → 차단", nodeBlocksPull({ tag: "TEXTAREA" }) === true);
ok("SELECT → 차단", nodeBlocksPull({ tag: "SELECT" }) === true);
ok("contentEditable → 차단", nodeBlocksPull({ tag: "DIV", contentEditable: true }) === true);
ok("role=dialog → 차단", nodeBlocksPull({ tag: "DIV", role: "dialog" }) === true);
ok("aria-modal → 차단", nodeBlocksPull({ tag: "DIV", ariaModal: true }) === true);
ok("position:fixed(모달 오버레이) → 차단", nodeBlocksPull({ tag: "DIV", position: "fixed" }) === true);
// 핵심 회귀: overflow-y auto는 스크롤 양 무관 차단(이전 사각지대)
ok("overflow-y auto(짧은 overflow) → 차단", nodeBlocksPull({ tag: "DIV", overflowY: "auto" }) === true);
ok("overflow-y scroll → 차단", nodeBlocksPull({ tag: "DIV", overflowY: "scroll" }) === true);
ok("일반 콘텐츠(overflow visible/static) → 통과", nodeBlocksPull({ tag: "DIV", overflowY: "visible", position: "static" }) === false);

// ── 실제 DOM 3경계 (jsdom) ──────────────────────────────────
const { window } = new JSDOM(`<!DOCTYPE html><body></body>`);
const doc = window.document;
// 컴포넌트가 참조하는 DOM 전역(window/HTMLElement/getComputedStyle)을 jsdom 것으로 세팅
const g = globalThis as unknown as { window: unknown; HTMLElement: unknown; Element: unknown };
g.window = window;
g.HTMLElement = window.HTMLElement;
g.Element = window.Element;

function el(tag: string, style = "", attrs: Record<string, string> = {}) {
  const n = doc.createElement(tag);
  if (style) n.setAttribute("style", style);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// container(최상위 PTR 래퍼)
const container = el("div");
doc.body.appendChild(container);

// (1) 모달 패딩 DIV: overflow-y auto·짧은 overflow(scrollHeight===clientHeight)·role 없음 → 차단
const modalPad = el("div", "overflow-y: auto;");
const modalInput = el("input");
modalPad.appendChild(modalInput);
container.appendChild(modalPad);
ok("[DOM] 모달 패딩 DIV(overflow auto, 짧음) 시작 → 차단", pullStartIsBlocked(modalInput, container) === true);

// (2) 짧은 overflow 컨테이너 자체에서 시작 → 차단(양 무관)
const shortOverflow = el("div", "overflow-y: auto;");
const shortChild = el("span");
shortOverflow.appendChild(shortChild);
container.appendChild(shortOverflow);
ok("[DOM] 짧은 overflow 스크롤러 시작 → 차단", pullStartIsBlocked(shortChild, container) === true);

// (3) 일반 page-level 콘텐츠(overflow 없음) 시작 → 통과(arm)
const pageContent = el("div");
const pageChild = el("p");
pageContent.appendChild(pageChild);
container.appendChild(pageContent);
ok("[DOM] 일반 page 콘텐츠 시작 → 통과(arm)", pullStartIsBlocked(pageChild, container) === false);

// (4) 모달 안 SVG 아이콘(<svg><path>)에서 시작 → 부모 modal(fixed) 감지 차단 (삼순 3차 NO-GO)
const SVG_NS = "http://www.w3.org/2000/svg";
const modalFixed = el("div", "position: fixed;");
const svgIcon = doc.createElementNS(SVG_NS, "svg");
const svgPath = doc.createElementNS(SVG_NS, "path");
svgIcon.appendChild(svgPath);
modalFixed.appendChild(svgIcon);
container.appendChild(modalFixed);
ok("[DOM] 모달 안 SVG path 시작 → 부모 fixed 감지 차단", pullStartIsBlocked(svgPath, container) === true);

// (5) 일반 page 콘텐츠의 SVG 아이콘 → 통과(실제 아이콘 touch 보존)
const plainIconWrap = el("div");
const plainSvg = doc.createElementNS(SVG_NS, "svg");
const plainPath = doc.createElementNS(SVG_NS, "path");
plainSvg.appendChild(plainPath);
plainIconWrap.appendChild(plainSvg);
container.appendChild(plainIconWrap);
ok("[DOM] 일반 page SVG 아이콘 → 통과(arm 보존)", pullStartIsBlocked(plainPath, container) === false);

console.log(`\npull-to-refresh smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
