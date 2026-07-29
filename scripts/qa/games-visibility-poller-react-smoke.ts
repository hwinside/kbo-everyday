/**
 * 경기목록 폴링 실제 React/async 회귀.
 * 최초 live load 중복 0, Promise single-flight, hidden→visible 즉시 1회,
 * 날짜 전환 1회, 늦은 이전 날짜 응답 폐기를 고정한다.
 */
import { JSDOM } from "jsdom";
import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useVisibilityAwareInterval } from "../../src/lib/hooks/useVisibilityAwareInterval";
import {
  createRequestCoordinator,
  type RequestToken,
} from "../../src/lib/polling/request-coordinator";

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
  get: () => hidden ? "hidden" : "visible",
  configurable: true,
});

type Payload = { date: string; live: boolean };
type Pending = {
  date: string;
  resolve: (payload: Payload) => void;
  settled: boolean;
};
const pending: Pending[] = [];
let active = 0;
let maxActiveSameTarget = 0;
const activeByDate = new Map<string, number>();

function deferredLoad(date: string): Promise<Payload> {
  active += 1;
  const nextForDate = (activeByDate.get(date) ?? 0) + 1;
  activeByDate.set(date, nextForDate);
  maxActiveSameTarget = Math.max(maxActiveSameTarget, nextForDate);
  return new Promise((resolve) => {
    pending.push({
      date,
      settled: false,
      resolve: (payload) => {
        active -= 1;
        activeByDate.set(date, (activeByDate.get(date) ?? 1) - 1);
        resolve(payload);
      },
    });
  });
}

function Harness({ date }: { date: string }) {
  const [coordinator] = useState(() => createRequestCoordinator<Payload>());
  const [shown, setShown] = useState<Payload | null>(null);

  const load = useCallback(async (token: RequestToken) => {
    const result = await coordinator.run(token, () => deferredLoad(token.key));
    if (result.status === "current") setShown(result.value);
  }, [coordinator]);

  useEffect(() => {
    const token = coordinator.switchTarget(date);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(token);
    return () => coordinator.dispose();
  }, [coordinator, date, load]);

  const refresh = useCallback(() => {
    const token = coordinator.currentToken() ?? coordinator.switchTarget(date);
    return load(token);
  }, [coordinator, date, load]);
  useVisibilityAwareInterval(refresh, 100, {
    enabled: shown?.date === date && shown.live,
    resetKey: date,
    runImmediately: false,
  });

  return React.createElement("output", null, shown ? `${shown.date}:${shown.live ? "live" : "scheduled"}` : "loading");
}

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean) {
  if (condition) pass += 1;
  else { fail += 1; console.error(`  ✗ ${name}`); }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
}
function calls(date: string) {
  return pending.filter((request) => request.date === date).length;
}
async function settle(date: string, live: boolean) {
  const request = pending.find((item) => item.date === date && !item.settled);
  if (!request) throw new Error(`pending request missing: ${date}`);
  request.settled = true;
  request.resolve({ date, live });
  await sleep(0);
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

  root.render(React.createElement(Harness, { date: "A" }));
  await waitFor(() => calls("A") === 1);
  check("최초 A load 정확히 1건", calls("A") === 1);
  await settle("A", true);
  await waitFor(() => container.textContent === "A:live");
  await sleep(40);
  check("live 최초 응답 뒤 100ms 전 추가 요청 0", calls("A") === 1);

  await waitFor(() => calls("A") === 2);
  check("100ms cadence에서 두 번째 요청", calls("A") === 2);
  await setHidden(true);
  await setHidden(false);
  check("A pending 중 복귀는 overlap 0", calls("A") === 2 && maxActiveSameTarget === 1);
  await settle("A", true);
  await waitFor(() => calls("A") === 3);
  check("pending settle 뒤 복귀 갱신 정확히 1건", calls("A") === 3 && maxActiveSameTarget === 1);

  root.render(React.createElement(Harness, { date: "B" }));
  await waitFor(() => calls("B") === 1);
  check("날짜 전환 B 요청 정확히 1건", calls("B") === 1);
  await settle("B", false);
  await waitFor(() => container.textContent === "B:scheduled");
  await settle("A", true);
  await sleep(30);
  check("늦은 A 응답이 B를 덮지 않음", container.textContent === "B:scheduled");
  check("B 최초 load 뒤 추가 요청 0", calls("B") === 1);
  check("같은 대상 동시 요청 최대 1", maxActiveSameTarget === 1);
  check("모든 deferred 요청 settle", active === 0);

  root.unmount();
  container.remove();
  console.log(`\ngames-visibility-poller-react: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
  if (fail) process.exitCode = 1;
}

void main();
