/**
 * ContextualStatsBox gameId 세대 fence 회귀 (삼순 PR #949 라운드1 blocker P1-2).
 * 실제 React(jsdom) mount + global.fetch 주입으로, 컴포넌트가 유지된 채 gameId가
 * 바뀔 때 이전 경기의 늦은 응답이 현재 경기 데이터를 덮지 않음을 고정한다.
 *
 * S1) A fetch pending → gameId B 전환 → B resolve(반영) → 늦은 A resolve → DOM은 B 유지
 * S2) 키보드 오픈(body.kbd-open) 중 응답 → commit 보류(data 미변경)
 * S3) enabled=false → 폴링/fetch 0
 * S4) 언마운트 후 늦은 응답 → commit 없음(에러 없음)
 *
 * 실행: npx tsx scripts/qa/contextual-stats-fence-smoke.ts
 */
import { JSDOM } from "jsdom";
import type {
  ContextualStatsResponse,
} from "../../src/lib/contextual-stats/types";

const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
try {
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
} catch { /* Node navigator 재정의 불가 시 기존 것 사용 */ }
// 컴포넌트·framer-motion이 기대하는 window 전역을 노출(MutationObserver 등).
for (const key of [
  "MutationObserver", "HTMLElement", "Element", "Node", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "DOMRect", "CustomEvent", "Event",
]) {
  if (g[key] === undefined && (dom.window as unknown as Record<string, unknown>)[key] !== undefined) {
    g[key] = (dom.window as unknown as Record<string, unknown>)[key];
  }
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${name}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 1500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

/** phBA 라인만 채운 최소 유효 응답(batterName이 DOM에 렌더됨). */
function resp(gameId: string, batterName: string): ContextualStatsResponse {
  return {
    gameId,
    context: {
      gameId, inning: 1, isTop: true, outs: 0, balls: 0, strikes: 0,
      bases: { first: false, second: false, third: false },
      batterKboId: null, pitcherKboId: null,
      batterName, pitcherName: null, batterIsPinch: true,
    },
    lines: {
      vsHand: null, basesLoaded: null, risp: null, twoOuts: null,
      phBA: { value: { AVG: "0.345", AB: 20 }, reason: "test" },
    },
    highlights: { cycle: null, noHitter: null, milestone: null, hrLeader: null },
    fetchedAt: new Date().toISOString(),
    empty: false,
  };
}

/** 제어 가능한 global.fetch — 호출마다 요청 gameId + deferred resolve를 쌓는다. */
function installFetch() {
  const calls: Array<{ gameId: string; resolve: (r: ContextualStatsResponse) => void }> = [];
  g.fetch = (url: string) => {
    const gameId = new URL(url, "http://localhost").searchParams.get("gameId") ?? "";
    return new Promise((resolve) => {
      calls.push({
        gameId,
        resolve: (body: ContextualStatsResponse) =>
          resolve({ ok: true, json: async () => body } as unknown as Response),
      });
    });
  };
  return {
    calls,
    /** 특정 gameId의 가장 오래된 pending 호출을 resolve. */
    async resolveFor(gameId: string, batterName: string) {
      const i = calls.findIndex((c) => c.gameId === gameId && !("done" in c));
      if (i >= 0) {
        (calls[i] as { done?: boolean }).done = true;
        calls[i].resolve(resp(gameId, batterName));
        await sleep(0);
      }
    },
  };
}

async function main() {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { default: ContextualStatsBox } = await import("../../src/components/game/ContextualStatsBox");

  const boxText = (out: HTMLElement) =>
    (out.querySelector("[data-contextual-stats-box]")?.textContent ?? "");

  // ── S1) stale gameId 응답이 현재 경기를 덮지 않음 ──
  {
    const fetchCtl = installFetch();
    const out = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(out);
    const root = createRoot(out);

    root.render(React.createElement(ContextualStatsBox, { gameId: "GAME_A", enabled: true }));
    await waitFor(() => fetchCtl.calls.some((c) => c.gameId === "GAME_A"));
    check("S1: gameId=A poll fetch 발생", fetchCtl.calls.some((c) => c.gameId === "GAME_A"));

    // gameId B 전환 (A 응답 아직 pending)
    root.render(React.createElement(ContextualStatsBox, { gameId: "GAME_B", enabled: true }));
    await waitFor(() => fetchCtl.calls.some((c) => c.gameId === "GAME_B"));

    // B 먼저 반영
    await fetchCtl.resolveFor("GAME_B", "타자B");
    const shownB = await waitFor(() => boxText(out).includes("타자B"));
    check("S1: B 응답 반영(DOM에 타자B)", shownB);

    // 늦은 A 응답 → fence로 무시(현재 gameId=B)
    await fetchCtl.resolveFor("GAME_A", "타자A");
    await sleep(30);
    check("S1: 늦은 A 응답이 B를 덮지 않음(타자A 미노출)", !boxText(out).includes("타자A"));
    check("S1: DOM 여전히 타자B 유지", boxText(out).includes("타자B"));

    root.unmount();
    out.remove();
  }

  // ── S2) 키보드 오픈 중 응답은 commit 보류 ──
  {
    const fetchCtl = installFetch();
    const out = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(out);
    const root = createRoot(out);
    root.render(React.createElement(ContextualStatsBox, { gameId: "GAME_K", enabled: true }));
    await waitFor(() => fetchCtl.calls.some((c) => c.gameId === "GAME_K"));
    dom.window.document.body.classList.add("kbd-open");
    await fetchCtl.resolveFor("GAME_K", "타자K");
    await sleep(30);
    check("S2: 키보드 오픈 중 응답 commit 보류(박스 미노출)", boxText(out) === "");
    dom.window.document.body.classList.remove("kbd-open");
    root.unmount();
    out.remove();
  }

  // ── S3) enabled=false → 폴링/fetch 0 ──
  {
    const fetchCtl = installFetch();
    const out = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(out);
    const root = createRoot(out);
    root.render(React.createElement(ContextualStatsBox, { gameId: "GAME_D", enabled: false }));
    await sleep(80);
    check("S3: enabled=false면 fetch 0", fetchCtl.calls.length === 0);
    root.unmount();
    out.remove();
  }

  // ── S4) 언마운트 후 늦은 응답 → commit 없음(에러 없음) ──
  {
    const fetchCtl = installFetch();
    const out = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(out);
    const root = createRoot(out);
    root.render(React.createElement(ContextualStatsBox, { gameId: "GAME_U", enabled: true }));
    await waitFor(() => fetchCtl.calls.some((c) => c.gameId === "GAME_U"));
    root.unmount();
    let threw = false;
    try {
      await fetchCtl.resolveFor("GAME_U", "타자U");
      await sleep(20);
    } catch { threw = true; }
    check("S4: 언마운트 후 늦은 응답에 에러 없음", !threw);
    check("S4: 언마운트 후 DOM에 데이터 commit 없음", !out.textContent?.includes("타자U"));
    out.remove();
  }

  console.log(`\ncontextual-stats-fence: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
  if (fail) process.exit(1);
}

main();
