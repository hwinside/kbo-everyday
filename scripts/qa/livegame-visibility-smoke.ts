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
 * S5) gameDate A→B 전환 뒤 late A 응답은 B state를 덮지 않음
 * S6) poll pending 중 manual refetch는 single-flight 뒤 queued 1회로 합쳐짐
 * S7) hidden 중 live→final 전환은 복귀 첫 diff의 game_end/victory를 보존
 * S8) visible에서 시작한 poll이 hidden 중 final settle해도 복귀 victory를 보존
 *
 * 실행: npx tsx scripts/qa/livegame-visibility-smoke.ts
 */
import { JSDOM } from "jsdom";

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "qa-anon-key";

const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.localStorage = dom.window.localStorage;
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
function game(gameId: string, score: number, status: "live" | "final" = "live") {
  return {
    gameId, awayName: "키움", homeName: "LG",
    awayScore: 1, homeScore: score, inning: status === "live" ? 5 : 9, isTop: false,
    balls: 0, strikes: 0, outs: 0,
    runner1b: false, runner2b: false, runner3b: false,
    runner1bName: null, runner2bName: null, runner3bName: null,
    currentBatter: null, currentPitcher: null,
    currentInning: status === "live" ? "5회말" : "경기종료",
    stadium: "잠실", status, isLive: status === "live",
    awayStarterName: null, homeStarterName: null,
  };
}

function installFetch(score = 3) {
  fetchCount = 0;
  g.fetch = async () => {
    fetchCount++;
    const now = Date.now();
    return {
      ok: true,
      json: async () => ({
        games: [game("20260729WOLG0", score)],
        error: null,
        trace: { source: "qa", stage: "qa", sourceAtMs: now, fetchedAtMs: now },
      }),
    } as unknown as Response;
  };
}

interface PendingFetch {
  url: string;
  signal?: AbortSignal;
  resolve: (games: ReturnType<typeof game>[]) => void;
}

function installDeferredFetch() {
  fetchCount = 0;
  let active = 0;
  let maxActive = 0;
  const pending: PendingFetch[] = [];
  g.fetch = (input: string | URL | Request, init?: RequestInit) => {
    fetchCount++;
    active++;
    maxActive = Math.max(maxActive, active);
    return new Promise<Response>((resolve) => {
      pending.push({
        url: String(input),
        signal: init?.signal ?? undefined,
        resolve: (games) => {
          active--;
          const now = Date.now();
          resolve({
            ok: true,
            json: async () => ({
              games,
              error: null,
              trace: { source: "qa", stage: "qa", sourceAtMs: now, fetchedAtMs: now },
            }),
          } as Response);
        },
      });
    });
  };
  return { pending, get maxActive() { return maxActive; } };
}

async function main() {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { useLiveGame } = await import("../../src/lib/hooks/useLiveGame");
  const { useCelebration } = await import("../../src/lib/hooks/useCelebration");
  const { advanceClientGameEventTransition } = await import("../../src/lib/client-game-event-transition");
  type PrevGameState = import("../../src/lib/event-generator").PrevGameState;

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
  function LiveHost({ gameId, pollInterval = 60_000 }: { gameId: string; pollInterval?: number }) {
    const { games, game: current, loading, refetch } = useLiveGame(gameId, pollInterval);
    return React.createElement("div", { "data-testid": "host" },
      React.createElement("span", { "data-testid": "loading" }, loading ? "1" : "0"),
      React.createElement("span", { "data-testid": "game-id" }, current?.gameId ?? "-"),
      React.createElement("span", { "data-testid": "first-id" }, games[0]?.gameId ?? "-"),
      React.createElement("span", { "data-testid": "score" }, current ? String(current.homeScore) : "-"),
      React.createElement("span", { "data-testid": "status" }, current?.status ?? "-"),
      React.createElement("button", { "data-testid": "refetch", onClick: () => void refetch() }, "refetch"),
    );
  }
  function ResumeFinalHost({ gameId, pollInterval = 60_000 }: { gameId: string; pollInterval?: number }) {
    const { game: current } = useLiveGame(gameId, pollInterval);
    const previousRef = React.useRef<PrevGameState | null>(null);
    const skipNextRef = React.useRef(false);
    const { celebration, processEvents } = useCelebration({
      gameId,
      myTeamId: 1,
      homeTeamId: 1,
      awayTeamId: 2,
    });

    React.useEffect(() => {
      if (!current) return;
      const transition = advanceClientGameEventTransition({
        gameId,
        previous: previousRef.current,
        current,
        boxScore: null,
        skipNextDiff: skipNextRef.current,
        visibilityState: document.visibilityState,
      });
      previousRef.current = transition.nextState;
      skipNextRef.current = transition.skipNextDiff;
      if (transition.events.length > 0) {
        processEvents(transition.events, {
          preserveFreshGameEnd: transition.preserveFreshGameEnd,
        });
      }
    }, [current, gameId, processEvents]);

    React.useEffect(() => {
      const onVisible = () => {
        if (document.visibilityState === "visible") skipNextRef.current = true;
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => document.removeEventListener("visibilitychange", onVisible);
    }, []);

    return React.createElement("div", null,
      React.createElement("span", { "data-testid": "resume-status" }, current?.status ?? "-"),
      React.createElement("span", { "data-testid": "celebration" }, celebration?.type ?? "-"),
    );
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

  // ── S5) A pending → B 적용 → late A 미커밋 ──
  {
    const h = installDeferredFetch();
    hidden = false;
    const out = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(out);
    const root = createRoot(out);
    const gameA = "20260729WOLG0";
    const gameB = "20260730WOLG0";
    root.render(React.createElement(LiveHost, { gameId: gameA }));
    await waitFor(() => h.pending.length === 1);
    root.render(React.createElement(LiveHost, { gameId: gameB }));
    await waitFor(() => h.pending.length === 2);
    check("S5: date 전환이 이전 request를 abort", h.pending[0]?.signal?.aborted === true);
    h.pending[1].resolve([game(gameB, 2)]);
    await waitFor(() => read(out, "score") === "2");
    h.pending[0].resolve([game(gameA, 8)]);
    await sleep(30);
    check("S5: B 적용 뒤 late A는 현재 game을 제거하지 않음", read(out, "game-id") === gameB);
    check("S5: late A는 games state도 덮지 않음", read(out, "first-id") === gameB);
    check("S5: B score 유지", read(out, "score") === "2");
    root.unmount(); out.remove();
  }

  // ── S6) poll pending + manual refetch → 동시 요청 1, queued 최신 응답 유지 ──
  {
    const h = installDeferredFetch();
    hidden = false;
    const out = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(out);
    const root = createRoot(out);
    const gameId = "20260730WOLG0";
    root.render(React.createElement(LiveHost, { gameId }));
    await waitFor(() => h.pending.length === 1);
    (out.querySelector('[data-testid="refetch"]') as HTMLButtonElement).click();
    await sleep(20);
    check("S6: poll pending 중 manual refetch가 동시 요청을 만들지 않음", h.pending.length === 1);
    h.pending[0].resolve([game(gameId, 8, "live")]);
    await waitFor(() => h.pending.length === 2);
    check("S6: settle 뒤 queued refresh 정확히 1회", h.pending.length === 2);
    check("S6: 활성 generation 최대 동시 요청 1", h.maxActive === 1);
    h.pending[1].resolve([game(gameId, 9, "final")]);
    await waitFor(() => read(out, "status") === "final");
    await sleep(30);
    check("S6: queued 최신 final 유지", read(out, "status") === "final" && read(out, "score") === "9");
    root.unmount(); out.remove();
  }

  // ── S7) visibility 복귀 첫 live→final diff와 victory 보존 ──
  {
    const responses = [
      [game("20260730WOLG0", 2, "live")],
      [game("20260730WOLG0", 3, "final")],
    ];
    fetchCount = 0;
    g.fetch = async () => {
      const now = Date.now();
      return {
        ok: true,
        json: async () => ({
          games: responses[Math.min(fetchCount++, responses.length - 1)],
          error: null,
          trace: { source: "qa", stage: "qa", sourceAtMs: now, fetchedAtMs: now },
        }),
      } as Response;
    };
    hidden = false;
    const out = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(out);
    const root = createRoot(out);
    root.render(React.createElement(ResumeFinalHost, { gameId: "20260730WOLG0" }));
    await waitFor(() => read(out, "resume-status") === "live");
    setHidden(true);
    await sleep(20);
    setHidden(false);
    await waitFor(() => read(out, "resume-status") === "final");
    const victory = await waitFor(() => read(out, "celebration") === "victory");
    check("S7: 복귀 첫 live→final diff가 victory를 1회 보존", victory);
    root.unmount(); out.remove();
  }

  // ── S8) visible poll pending → hidden 중 final settle → 복귀 victory 1회 ──
  {
    const gameId = "20260731WOLG0";
    let pendingFinalResolve: (() => void) | null = null;
    let calls = 0;
    g.fetch = async () => {
      calls++;
      if (calls === 1) {
        const now = Date.now();
        return {
          ok: true,
          json: async () => ({
            games: [game(gameId, 2, "live")],
            error: null,
            trace: { source: "qa", stage: "qa", sourceAtMs: now, fetchedAtMs: now },
          }),
        } as Response;
      }
      if (calls === 2) {
        return await new Promise<Response>((resolve) => {
          pendingFinalResolve = () => {
            const now = Date.now();
            resolve({
              ok: true,
              json: async () => ({
                games: [game(gameId, 3, "final")],
                error: null,
                trace: { source: "qa", stage: "qa", sourceAtMs: now, fetchedAtMs: now },
              }),
            } as Response);
          };
        });
      }
      const now = Date.now();
      return {
        ok: true,
        json: async () => ({
          games: [game(gameId, 3, "final")],
          error: null,
          trace: { source: "qa", stage: "qa", sourceAtMs: now, fetchedAtMs: now },
        }),
      } as Response;
    };
    hidden = false;
    const out = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(out);
    const root = createRoot(out);
    root.render(React.createElement(ResumeFinalHost, { gameId, pollInterval: 40 }));
    await waitFor(() => read(out, "resume-status") === "live");
    await waitFor(() => calls === 2 && pendingFinalResolve !== null);
    setHidden(true);
    (pendingFinalResolve as (() => void) | null)?.();
    await waitFor(() => read(out, "resume-status") === "final");
    check("S8: hidden 중 final settle은 victory를 미리 소비하지 않음", read(out, "celebration") === "-");
    setHidden(false);
    await waitFor(() => calls === 3);
    const victory = await waitFor(() => read(out, "celebration") === "victory");
    check("S8: 복귀 fetch 뒤 pending game_end가 victory 정확히 1회 발화", victory);
    root.unmount(); out.remove();
  }

  console.log(`\nlivegame-visibility: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
  process.exit(fail ? 1 : 0);
}

main();
