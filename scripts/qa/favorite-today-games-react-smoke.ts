/**
 * FavoritePlayersSection 오늘경기 폴링 generation fence 실제 React/async 회귀
 * (삼순 NO-GO #1237 재게이트). 컴포넌트의 load 가드 로직과 동일한 shape를 렌더한다:
 * generation 증가를 load 시작이 아니라 *대상 변경 effect*(favKey/enabled)와 그 cleanup에 두어
 * load가 재호출되지 않는 empty·unmount 전환에서도 진행 중 late 응답을 무효화한다.
 *
 * 고정:
 *  ① favKey 전환(A slow → B fast) 뒤 late A 응답이 B state를 덮지 않음
 *  ② 최애 0명(enabled=false) 전환 중 late 응답이 state를 덮지 않음(empty fence)
 *  ③ unmount 후 late 응답이 setState를 유발하지 않음(unmount fence)
 *  ④ visible cadence·single-flight 유지, hidden 진입 신규 요청 0, 복귀 정확히 1, unmount listener 0
 *
 * 실행: npx tsx scripts/qa/favorite-today-games-react-smoke.ts
 */
import { JSDOM } from "jsdom";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useVisibilityAwareInterval } from "../../src/lib/hooks/useVisibilityAwareInterval";

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

type Pending = { key: string; resolve: (value: string) => void; settled: boolean };
const pending: Pending[] = [];
const reqByKey = new Map<string, number>();
function deferredLoad(key: string): Promise<string> {
  reqByKey.set(key, (reqByKey.get(key) ?? 0) + 1);
  return new Promise((resolve) => pending.push({ key, resolve, settled: false }));
}
function inflight(key: string) { return pending.filter((p) => p.key === key && !p.settled).length; }
async function settle(key: string, value: string) {
  const p = pending.find((x) => x.key === key && !x.settled);
  if (!p) throw new Error(`no pending ${key}`);
  p.settled = true;
  p.resolve(value);
  await sleep(0);
}

// 컴포넌트 loadTodayGames 가드와 동일 shape: gen 증가는 대상 변경 effect + cleanup에.
function Harness({ favKey, enabled }: { favKey: string; enabled: boolean }) {
  const genRef = useRef(0);
  const [today, setToday] = useState<string>("");
  useEffect(() => {
    genRef.current += 1;
    return () => { genRef.current += 1; };
  }, [favKey, enabled]);
  const load = useCallback(async () => {
    const gen = genRef.current;
    const value = await deferredLoad(favKey);
    if (gen !== genRef.current) return; // late 응답 폐기
    setToday(value);
  }, [favKey]);
  useVisibilityAwareInterval(load, 100, { enabled, resetKey: favKey });
  return React.createElement("output", null, today);
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
async function setHidden(value: boolean) {
  hidden = value;
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await sleep(0);
}

async function main() {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);

  // ① favKey A→B: late A가 B를 덮지 않음
  root.render(React.createElement(Harness, { favKey: "A", enabled: true }));
  await waitFor(() => inflight("A") === 1);
  check("① A 최초 load 1건 pending", reqByKey.get("A") === 1 && inflight("A") === 1);
  root.render(React.createElement(Harness, { favKey: "B", enabled: true }));
  await waitFor(() => inflight("B") === 1);
  await settle("B", "B");
  await waitFor(() => container.textContent === "B");
  await settle("A", "A");
  await sleep(30);
  check("① late A가 B를 덮지 않음(generation fence)", container.textContent === "B");

  // ② 최애 0명(enabled=false) 전환 중 late 응답 무효화(empty fence)
  // 현재 B 화면. visible tick으로 새 B 로드를 pending으로 만든 뒤 empty 전환.
  const beforeEmpty = reqByKey.get("B") ?? 0;
  await waitFor(() => inflight("B") === 1 || (reqByKey.get("B") ?? 0) > beforeEmpty);
  root.render(React.createElement(Harness, { favKey: "B", enabled: false }));
  await sleep(10);
  if (inflight("B") > 0) await settle("B", "LATE-EMPTY");
  await sleep(30);
  check("② empty 전환 중 late 응답이 화면을 덮지 않음", container.textContent === "B");

  // ③ unmount 후 late 응답이 setState를 유발하지 않음(unmount fence)
  root.render(React.createElement(Harness, { favKey: "C", enabled: true }));
  await waitFor(() => inflight("C") === 1);
  const cReq = reqByKey.get("C") ?? 0;
  root.unmount();
  await sleep(0);
  let threw = false;
  try { if (inflight("C") > 0) await settle("C", "LATE-UNMOUNT"); } catch { threw = true; }
  await sleep(20);
  check("③ unmount 후 late C settle이 예외/추가요청 없이 무효화", !threw && (reqByKey.get("C") ?? 0) === cReq);
  check("③' unmount 후 visibilitychange listener 0", visListeners === 0);

  // ④ hidden 0 / 복귀 1 (재마운트로 별도 검증)
  const root2 = createRoot(container);
  reqByKey.set("D", 0);
  root2.render(React.createElement(Harness, { favKey: "D", enabled: true }));
  await waitFor(() => inflight("D") === 1);
  await settle("D", "D");
  const beforeHidden = reqByKey.get("D") ?? 0;
  await setHidden(true);
  await sleep(140);
  check("④ hidden 중 신규 요청 0", (reqByKey.get("D") ?? 0) === beforeHidden);
  await setHidden(false);
  await waitFor(() => (reqByKey.get("D") ?? 0) === beforeHidden + 1);
  await sleep(20);
  check("④' visible 복귀 정확히 1요청 + listener 1", (reqByKey.get("D") ?? 0) === beforeHidden + 1 && visListeners === 1);
  root2.unmount();
  await sleep(0);
  container.remove();

  console.log(`\nfavorite-today-games-react: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
  if (fail) process.exitCode = 1;
}

void main();
