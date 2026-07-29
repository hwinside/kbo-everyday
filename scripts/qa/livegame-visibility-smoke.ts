/**
 * useLiveGame visibility-aware 폴링 회귀 (Tier1-② 확산 최종).
 * 실제 React(jsdom) mount + global.fetch 주입으로, useLiveGame이 공용 poller로
 * 배선되어 (1) pollInterval<=0 폴링 0·loading 해제 (2) 폴링 시 즉시 1회+주기
 * (3) 백그라운드 정지 (4) 복귀 즉시 갱신을 고정한다.
 *
 * S1) pollInterval=0 → fetch 0, loading=false (비경기시간 계약 보존)
 * S2) pollInterval>0, visible → 즉시 1회 fetch, game 데이터 반영
 * S3) hidden 중 → 주기 경과해도 추가 fetch 0
 * S4) hidden→visible 복귀 → 즉시 1회 추가 fetch
 *
 * 실행: npx tsx scripts/qa/livegame-visibility-smoke.ts
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
try {
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
} catch { /* keep existing */ }

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${name}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 1500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (cond()) return true; await sleep(10); }
  return cond();
}

/** document.hidden/visibilityState를 제어. */
let hidden = false;
Object.defineProperty(dom.window.document, "hidden", { configurable: true, get: () => hidden });
Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
function setHidden(v: boolean) {
  hidden = v;
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
}

/** fetch 호출 카운터 + game-live 응답 주입. */
let fetchCount = 0;
function installFetch(score = 3) {
  fetchCount = 0;
  g.fetch = async () => {
    fetchCount++;
    return {
      ok: true,
      json: async () => ({
        games: [{
          gameId: "20260729WOLG0", awayName: "키움", homeName: "LG",
          awayScore: 1, homeScore: score, inning: 5, isTop: false,
          balls: 0, strikes: 0, outs: 0,
          runner1b: false, runner2b: false, runner3b: false,
          runner1bName: null, runner2bName: null, runner3bName: null,
          currentBatter: null, currentPitcher: null, currentInning: "5회말",
          stadium: "잠실", status: "live", isLive: true,
          awayStarterName: null, homeStarterName: null,
        }],
        error: null,
      }),
    } as unknown as Response;
  };
}

async function main() {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { useLiveGame } = await import("../../src/lib/hooks/useLiveGame");

  // Host: pollInterval을 prop으로 받아 useLiveGame 마운트, game/loading을 DOM에 노출.
  function makeHost(pollInterval: number) {
    return function Host() {
      const { game, loading } = useLiveGame("20260729WOLG0", pollInterval);
      return React.createElement("div", { "data-testid": "host" },
        React.createElement("span", { "data-testid": "loading" }, loading ? "1" : "0"),
        React.createElement("span", { "data-testid": "score" }, game ? String(game.homeScore) : "-"),
      );
    };
  }
  const read = (out: HTMLElement, id: string) =>
    out.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

  // ── S1) pollInterval=0 → fetch 0, loading=false ──
  {
    installFetch();
    hidden = false;
    const out = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(out);
    const root = createRoot(out);
    root.render(React.createElement(makeHost(0)));
    await waitFor(() => read(out, "loading") === "0");
    check("S1: pollInterval=0 → loading 해제", read(out, "loading") === "0");
    await sleep(60);
    check("S1: pollInterval=0 → fetch 0(폴링 안 함)", fetchCount === 0);
    root.unmount(); out.remove();
  }

  // ── S2) pollInterval>0, visible → 즉시 1회 fetch + 반영 ──
  {
    installFetch(5);
    hidden = false;
    const out = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(out);
    const root = createRoot(out);
    root.render(React.createElement(makeHost(60))); // 60ms 폴링
    await waitFor(() => read(out, "score") === "5");
    check("S2: visible → 즉시 1회 fetch·game 반영(score=5)", read(out, "score") === "5");
    check("S2: 최초 fetch 발생", fetchCount >= 1);
    root.unmount(); out.remove();
  }

  // ── S3) hidden 중 → 추가 fetch 0 ──
  {
    installFetch();
    hidden = false;
    const out = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(out);
    const root = createRoot(out);
    root.render(React.createElement(makeHost(40)));
    await waitFor(() => fetchCount >= 1);
    setHidden(true);
    const before = fetchCount;
    await sleep(150); // 40ms 주기가 여러 번 지나도
    check("S3: hidden 중 추가 fetch 0(폴링 정지)", fetchCount === before);
    // ── S4) 복귀 → 즉시 1회 추가 fetch ──
    setHidden(false);
    const resumed = await waitFor(() => fetchCount === before + 1);
    check("S4: visible 복귀 → 즉시 1회 추가 fetch", resumed);
    root.unmount(); out.remove();
  }

  console.log(`\nlivegame-visibility: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
  if (fail) process.exit(1);
}

main();
