/**
 * Smoke test for /api/contextual-stats KBO→Naver current-state failover.
 *
 * Why
 * ---
 * fetchLiveGame() reads the *current batter/pitcher* off KBO GetKboGameList.
 * When KBO hard-fails (HTTP !ok or JSON parse fail) it used to null-degrade,
 * blanking the whole contextual-stats box even while Naver relay still knows
 * who is at bat. This wires the shared Naver failover (fetchKboLiveGames,
 * whose naverGameToRaw maps relay currentGameState → B_P_NM/T_P_NM with the
 * matching GAME_TB_SC) into fetchLiveGame's failure branch.
 *
 * Fault injection (no network): fetchLiveGame(gameId, fetchImpl, failoverImpl).
 *
 * Assertions
 * ----------
 *   T1: KBO normal path unchanged — KBO ok + game found → uses KBO, no failover
 *   T2: KBO HTTP 500 + Naver ok(top) → batter/pitcher enriched from Naver
 *   T3: KBO JSON parse fail + Naver ok(bottom) → correct isTop-inverted mapping
 *   T4: KBO HTTP 500 + Naver ok:false → null degrade (fail-close)
 *   T5: KBO HTTP 500 + Naver ok but game absent → null degrade (fail-close)
 *   T6: KBO ok-but-game-not-found (soft) → null, failover NOT invoked (preserve)
 */

// Pre-inject dummy SUPABASE env — importing the route transitively loads the
// supabase/admin singleton, which requires env at module-eval time. Must be
// first (ESM eval order). Production unaffected.
import "./_smoke-env";
import { fetchLiveGame } from "@/app/api/contextual-stats/route";
import { naverGameToRaw } from "@/lib/notifications/kbo-live-games";
import type { KboGame } from "@/lib/crawler/kbo-api";
import type { KboRawGame } from "@/types/api";

let failures = 0;

function assert(label: string, ok: boolean, detail?: unknown): void {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${label}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log("  detail:", detail);
  }
}

const GAME_ID = "20260731LTOB0";

function mkResponse(body: string, ok: boolean): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

// A KBO GetKboGameList JSON body containing our game (top of inning).
function kboBodyWithGame(isTop: boolean): string {
  const game: Partial<KboRawGame> = {
    G_ID: GAME_ID,
    GAME_TB_SC: isTop ? "T" : "B",
    GAME_INN_NO: 4,
    // In KBO shape, T_P_NM is the away-side name slot, B_P_NM the home-side.
    // isTop → batter = T_P_NM, pitcher = B_P_NM.
    T_P_NM: isTop ? "KBO타자" : "KBO투수",
    B_P_NM: isTop ? "KBO투수" : "KBO타자",
  };
  return JSON.stringify({ game: [game] });
}

// Build a Naver-origin KboRawGame via the real naverGameToRaw mapping so the
// test exercises the actual field wiring, not a hand-rolled shape.
function naverRaw(isTop: boolean, batter: string, pitcher: string): KboRawGame {
  const game: Partial<KboGame> = {
    gameId: GAME_ID,
    date: "20260731",
    time: "18:30",
    stadium: "사직",
    awayName: "롯데",
    homeName: "두산",
    awayScore: 1,
    homeScore: 2,
    inning: 4,
    isTop,
    status: "live",
    strikes: 1,
    balls: 2,
    outs: 1,
    runnersOn: { first: false, second: false, third: false },
    currentPitcher: pitcher,
    currentBatter: batter,
  };
  return naverGameToRaw(game as KboGame);
}

type Failover = typeof import("@/lib/notifications/kbo-live-games").fetchKboLiveGames;

function okFailover(games: KboRawGame[]): Failover {
  return (async () => ({
    ok: true,
    games,
    trace: { source: "naver" as const, sourceAtMs: 0, fetchedAtMs: 0 },
  })) as unknown as Failover;
}

const failClosedFailover: Failover = (async () => ({
  ok: false,
  games: [],
  trace: { source: "kbo" as const, sourceAtMs: 0, fetchedAtMs: 0 },
})) as unknown as Failover;

function trackingFailover(games: KboRawGame[]): { impl: Failover; calls: () => number } {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return {
      ok: true,
      games,
      trace: { source: "naver" as const, sourceAtMs: 0, fetchedAtMs: 0 },
    };
  }) as unknown as Failover;
  return { impl, calls: () => calls };
}

async function main() {
  // T1: KBO normal path — ok + game found, failover must NOT be called.
  {
    const kboFetch = (async () => mkResponse(kboBodyWithGame(true), true)) as unknown as typeof fetch;
    const fo = trackingFailover([]);
    const snap = await fetchLiveGame(GAME_ID, kboFetch, fo.impl);
    assert(
      "T1 KBO ok+found → KBO used, no failover",
      snap?.batterName === "KBO타자" && snap?.pitcherName === "KBO투수" && fo.calls() === 0,
      { snap, failoverCalls: fo.calls() },
    );
  }

  // T2: KBO HTTP 500 → Naver ok (top). batter=T_P_NM=currentBatter, pitcher=B_P_NM=currentPitcher.
  {
    const kboFetch = (async () => mkResponse("", false)) as unknown as typeof fetch;
    const naver = naverRaw(true, "네이버타자", "네이버투수");
    const snap = await fetchLiveGame(GAME_ID, kboFetch, okFailover([naver]));
    assert(
      "T2 KBO 500 + Naver top → batter/pitcher enriched",
      snap?.batterName === "네이버타자" && snap?.pitcherName === "네이버투수",
      snap,
    );
  }

  // T3: KBO JSON parse fail → Naver ok (bottom). Verifies isTop-inverted mapping.
  {
    const kboFetch = (async () => mkResponse("NOT_JSON<<<", true)) as unknown as typeof fetch;
    const naver = naverRaw(false, "말타자", "말투수");
    const snap = await fetchLiveGame(GAME_ID, kboFetch, okFailover([naver]));
    assert(
      "T3 KBO parse-fail + Naver bottom → correct mapping",
      snap?.batterName === "말타자" && snap?.pitcherName === "말투수",
      snap,
    );
  }

  // T4: KBO 500 + Naver ok:false → null degrade (fail-close).
  {
    const kboFetch = (async () => mkResponse("", false)) as unknown as typeof fetch;
    const snap = await fetchLiveGame(GAME_ID, kboFetch, failClosedFailover);
    assert("T4 KBO 500 + Naver ok:false → null", snap === null, snap);
  }

  // T5: KBO 500 + Naver ok but game absent → null degrade (fail-close).
  {
    const kboFetch = (async () => mkResponse("", false)) as unknown as typeof fetch;
    const other = naverRaw(true, "x", "y");
    other.G_ID = "20260731XXOO0";
    const snap = await fetchLiveGame(GAME_ID, kboFetch, okFailover([other]));
    assert("T5 KBO 500 + Naver game absent → null", snap === null, snap);
  }

  // T6: KBO ok but game not in list (soft) → null, failover NOT invoked (preserve current behavior).
  {
    const kboFetch = (async () => mkResponse(JSON.stringify({ game: [] }), true)) as unknown as typeof fetch;
    const fo = trackingFailover([naverRaw(true, "a", "b")]);
    const snap = await fetchLiveGame(GAME_ID, kboFetch, fo.impl);
    assert(
      "T6 KBO ok+not-found → null, no failover",
      snap === null && fo.calls() === 0,
      { snap, failoverCalls: fo.calls() },
    );
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
