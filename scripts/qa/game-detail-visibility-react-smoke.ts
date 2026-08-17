/**
 * useGameDetail visibility-aware 폴링 실제 React/async 회귀 (삼순 NO-GO #1237 재게이트).
 *
 * 실제 훅을 렌더해서 고정한다:
 *  ① 최초 visible load 정확히 1
 *  ② hidden 진입 후 신규 요청 0 (in-flight 제외)
 *  ③ visible 복귀 정확히 1 (poller 단독 resume — 2/3요청 아님)
 *  ④ final+box stop 후 복귀로 되살아나지 않음 (신규 요청 0)
 *  ⑤ gameId 전환마다 visibilitychange listener 누적 0 (leak 없음)
 *
 * 실행: npx tsx scripts/qa/game-detail-visibility-react-smoke.ts
 */
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { useGameDetail } from "../../src/lib/hooks/useGameDetail";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
for (const key of ["HTMLElement", "Element", "Node", "Event"]) {
  globals[key] = (dom.window as unknown as Record<string, unknown>)[key];
}

let hidden = false;
Object.defineProperty(dom.window.document, "visibilityState", {
  get: () => (hidden ? "hidden" : "visible"),
  configurable: true,
});

// visibilitychange listener 수를 센다(leak 검출).
let visListeners = 0;
const origAdd = dom.window.document.addEventListener.bind(dom.window.document);
const origRemove = dom.window.document.removeEventListener.bind(dom.window.document);
(dom.window.document as unknown as { addEventListener: unknown }).addEventListener = (
  type: string,
  ...rest: unknown[]
) => {
  if (type === "visibilitychange") visListeners += 1;
  return (origAdd as (t: string, ...a: unknown[]) => unknown)(type, ...rest);
};
(dom.window.document as unknown as { removeEventListener: unknown }).removeEventListener = (
  type: string,
  ...rest: unknown[]
) => {
  if (type === "visibilitychange") visListeners = Math.max(0, visListeners - 1);
  return (origRemove as (t: string, ...a: unknown[]) => unknown)(type, ...rest);
};

// game-detail fetch mock: gameId별 요청 카운트 + 상태(live/final) 제어.
const reqByGame = new Map<string, number>();
const statusByGame = new Map<string, "live" | "final">();
globals.fetch = (async (url: string) => {
  const gid = new URLSearchParams(String(url).split("?")[1] ?? "").get("gameId") ?? "";
  reqByGame.set(gid, (reqByGame.get(gid) ?? 0) + 1);
  const status = statusByGame.get(gid) ?? "live";
  const now = Date.now();
  const boxScore = status === "final"
    ? { awayBatters: [{}], homeBatters: [{}] }
    : { awayBatters: [], homeBatters: [] };
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status,
      trace: { sourceAtMs: now, fetchedAtMs: now, lineupSource: "kbo", boxScoreSource: "kbo" },
      boxScore,
      lineup: null,
    }),
  };
}) as unknown as typeof fetch;

function Harness({ gameId }: { gameId: string }) {
  useGameDetail(gameId, 50);
  return null;
}

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean) {
  if (condition) pass += 1;
  else { fail += 1; console.error(`  ✗ ${name}`); }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
}
function reqs(gid: string) { return reqByGame.get(gid) ?? 0; }
async function setHidden(value: boolean) {
  hidden = value;
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await sleep(0);
}

async function main() {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);

  // ① 최초 visible → 정확히 1
  root.render(React.createElement(Harness, { gameId: "A" }));
  await waitFor(() => reqs("A") >= 1);
  await sleep(20);
  check("① 최초 visible load 정확히 1", reqs("A") === 1);

  // ② hidden 진입 → 신규 요청 0 (2 인터벌 대기)
  await setHidden(true);
  const beforeHidden = reqs("A");
  await sleep(140);
  check("② hidden 중 신규 요청 0", reqs("A") === beforeHidden);

  // ③ visible 복귀 → 정확히 1 (poller 단독, 2/3 아님)
  await setHidden(false);
  await waitFor(() => reqs("A") === beforeHidden + 1);
  await sleep(20);
  check("③ visible 복귀 정확히 1요청", reqs("A") === beforeHidden + 1);

  // ④ final+box stop 후 복귀로 되살아나지 않음
  statusByGame.set("A", "final");
  await waitFor(() => reqs("A") >= beforeHidden + 2); // 다음 tick이 final을 받아 stop
  await sleep(60);
  const afterFinal = reqs("A");
  await setHidden(true);
  await setHidden(false);
  await sleep(120);
  check("④ final stop 후 복귀로 되살아나지 않음(신규 0)", reqs("A") === afterFinal);

  // ⑤ gameId 전환 → listener 누적 0 (leak 없음)
  const listenersBeforeSwitch = visListeners;
  root.render(React.createElement(Harness, { gameId: "B" }));
  await waitFor(() => reqs("B") >= 1);
  await sleep(20);
  check("⑤ gameId 전환 후 visibilitychange listener 1개 유지(leak 0)", visListeners === listenersBeforeSwitch && visListeners === 1);
  const bAfterSwitch = reqs("B");
  await setHidden(true);
  await setHidden(false);
  await sleep(20);
  check("⑤' 전환 후에도 복귀 정확히 1 + listener 1", reqs("B") === bAfterSwitch + 1 && visListeners === 1);

  root.unmount();
  await sleep(0);
  check("unmount 후 visibilitychange listener 0", visListeners === 0);
  container.remove();

  console.log(`\ngame-detail-visibility-react: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
  if (fail) process.exitCode = 1;
}

void main();
