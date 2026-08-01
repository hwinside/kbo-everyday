/**
 * fetchKboLiveGames dual-source failover 회귀 + actual GET /api/game-live 회귀.
 *
 * 고정하는 계약(삼순 1·2차 리뷰 blocker):
 * - KBO HTTP/network/schema 실패 → Naver failover(ok:true, source:"naver").
 * - KBO 200 + 빈 game 배열(soft-empty)은 Naver 교차확인 후에만 authoritative —
 *   Naver 에 경기가 있으면 Naver 사용(블랙홀 방지), Naver 도 무경기일 때만 KBO empty 인정.
 * - Naver failover live 경기는 relay currentGameState 로 볼카운트(B/S/O)·주자·현재
 *   투수/타자를 enrichment(1회초 이후 포함). relay 실패는 per-game fail-soft(zero 유지, live 유지).
 * - 1회초 0:0 은 첫 투구 증거(hasRealPlay) 없으면 scheduled 유지.
 * - actual /api/game-live: KBO 실패 시에도 user-facing 필드(balls/strikes/outs/
 *   runners/currentPitcher/currentBatter)가 Naver relay 값으로 채워진다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import type { KboGame } from "../../src/lib/crawler/kbo-api";

// import 체인(api-fallback-tracker → supabase admin)이 모듈 스코프에서 env 를 요구하므로
// 앱 코드는 env 설정 후 동적 import 한다(game-detail smoke 와 동일 패턴).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "smoke-service-role-key";

type FetchKboLiveGames =
  typeof import("../../src/lib/notifications/kbo-live-games").fetchKboLiveGames;
let fetchKboLiveGames: FetchKboLiveGames;

const naverGames: KboGame[] = [{
  gameId: "20260730WOLG0",
  date: "20260730",
  time: "18:30",
  stadium: "잠실",
  awayTeamId: 10,
  homeTeamId: 3,
  awayName: "키움",
  homeName: "LG",
  awayScore: 0,
  homeScore: 0,
  inning: 2,
  isTop: true,
  status: "live",
  awayStarterName: "",
  homeStarterName: "",
  winPitcher: "",
  losePitcher: "",
  savePitcher: "",
  strikes: 0,
  balls: 0,
  outs: 0,
  runnersOn: { first: false, second: false, third: false },
  currentPitcher: "",
  currentBatter: "",
  awayRank: 0,
  homeRank: 0,
}];

const zeroEvidence = {
  hasRealPlay: true,
  balls: 0,
  strikes: 0,
  outs: 0,
  runner1b: false,
  runner2b: false,
  runner3b: false,
  runner1bOrder: 0,
  runner2bOrder: 0,
  runner3bOrder: 0,
  currentPitcher: "",
  currentBatter: "",
};

async function main() {
  ({ fetchKboLiveGames } = await import("../../src/lib/notifications/kbo-live-games"));
  let naverCalls = 0;
  const failedKbo = async () => new Response(null, { status: 503 });
  const naver = async () => {
    naverCalls += 1;
    return naverGames;
  };

  // 1) KBO 실패 → Naver failover + relay enrichment(2회 경기도 카운트/투타 채움).
  const fallback = await fetchKboLiveGames(
    "20260730",
    Date.now() + 2_000,
    failedKbo as typeof fetch,
    naver,
    async () => ({
      hasRealPlay: true,
      balls: 2,
      strikes: 1,
      outs: 1,
      runner1b: true,
      runner2b: false,
      runner3b: true,
      runner1bOrder: 8,
      runner2bOrder: 0,
      runner3bOrder: 6,
      currentPitcher: "네일",
      currentBatter: "김지찬",
    }),
  );
  assert.equal(fallback.ok, true);
  assert.equal(fallback.trace.source, "naver");
  assert.equal(naverCalls, 1);
  assert.deepEqual(fallback.games[0], {
    G_ID: "20260730WOLG0",
    G_DT: "20260730",
    G_TM: "18:30",
    S_NM: "잠실",
    AWAY_ID: "WO",
    HOME_ID: "LG",
    AWAY_NM: "키움",
    HOME_NM: "LG",
    T_SCORE_CN: "0",
    B_SCORE_CN: "0",
    GAME_INN_NO: 2,
    GAME_TB_SC: "T",
    GAME_STATE_SC: "2",
    CANCEL_SC_ID: "0",
    T_PIT_P_NM: "",
    B_PIT_P_NM: "",
    W_PIT_P_NM: "",
    L_PIT_P_NM: "",
    SV_PIT_P_NM: "",
    STRIKE_CN: 1,
    BALL_CN: 2,
    OUT_CN: 1,
    B1_BAT_ORDER_NO: 8,
    B2_BAT_ORDER_NO: 0,
    B3_BAT_ORDER_NO: 6,
    B_P_NM: "네일",
    T_P_NM: "김지찬",
    T_RANK_NO: 0,
    B_RANK_NO: 0,
  });

  // 2) relay enrichment 실패 → per-game fail-soft: live 유지 + zero/empty 유지.
  const enrichFailed = await fetchKboLiveGames(
    "20260730",
    Date.now() + 2_000,
    failedKbo as typeof fetch,
    naver,
    async () => { throw new Error("relay down"); },
  );
  assert.equal(enrichFailed.ok, true);
  assert.equal(enrichFailed.games[0].GAME_STATE_SC, "2");
  assert.equal(enrichFailed.games[0].BALL_CN, 0);
  assert.equal(enrichFailed.games[0].B_P_NM, "");

  // 3) KBO 정상(경기 있음) → Naver 미호출.
  naverCalls = 0;
  let kboRequestUserAgent = "";
  const kbo = await fetchKboLiveGames(
    "20260730",
    Date.now() + 2_000,
    (async (_input: RequestInfo | URL, init?: RequestInit) => {
      kboRequestUserAgent = new Headers(init?.headers).get("user-agent") ?? "";
      return new Response(JSON.stringify({
        game: [{
          G_ID: "20260730HTSS0",
          GAME_STATE_SC: "1",
          AWAY_NM: "KIA",
          HOME_NM: "삼성",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    naver,
  );
  assert.equal(kbo.ok, true);
  assert.equal(kbo.trace.source, "kbo");
  assert.equal(naverCalls, 0);
  assert.match(kboRequestUserAgent, /Chrome\//);
  assert.doesNotMatch(kboRequestUserAgent, /KboEveryday/);

  const kboEmpty = (async () => new Response(JSON.stringify({ game: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

  // 4) KBO 200 soft-empty + Naver 에 경기 있음 → Naver 사용(블랙홀 방지).
  naverCalls = 0;
  const softEmpty = await fetchKboLiveGames(
    "20260730",
    Date.now() + 2_000,
    kboEmpty,
    naver,
    async () => zeroEvidence,
  );
  assert.equal(softEmpty.ok, true);
  assert.equal(softEmpty.trace.source, "naver");
  assert.equal(softEmpty.games.length, 1);
  assert.equal(naverCalls, 1);

  // 5) KBO 200 empty + Naver 도 무경기 → KBO empty authoritative(source:"kbo").
  naverCalls = 0;
  const bothEmpty = await fetchKboLiveGames(
    "20260730",
    Date.now() + 2_000,
    kboEmpty,
    (async () => {
      naverCalls += 1;
      return [];
    }),
  );
  assert.equal(bothEmpty.ok, true);
  assert.equal(bothEmpty.trace.source, "kbo");
  assert.deepEqual(bothEmpty.games, []);
  assert.equal(naverCalls, 1);

  // 6) KBO 200 empty + Naver 확인 실패 → dual-source 불확실 = ok:false fail-close
  //    (검증 안 된 soft-empty를 정상 무경기로 인정하면 watchdog 0경기 blackhole — 삼순 3차 P0).
  const emptyNaverDown = await fetchKboLiveGames(
    "20260730",
    Date.now() + 2_000,
    kboEmpty,
    async () => { throw new Error("naver down"); },
  );
  assert.equal(emptyNaverDown.ok, false);
  assert.deepEqual(emptyNaverDown.games, []);

  // 7) 1회초 0:0 + 첫 투구 증거 없음 → scheduled 유지.
  const prePitch = await fetchKboLiveGames(
    "20260730",
    Date.now() + 2_000,
    failedKbo as typeof fetch,
    async () => [{ ...naverGames[0], inning: 1, isTop: true, awayScore: 0, homeScore: 0 }],
    async () => ({ ...zeroEvidence, hasRealPlay: false }),
  );
  assert.equal(prePitch.ok, true);
  assert.equal(prePitch.games[0].GAME_STATE_SC, "1");

  // 8) 1회초 첫 투구 확인 → live + 카운트 반영.
  const firstPitch = await fetchKboLiveGames(
    "20260730",
    Date.now() + 2_000,
    failedKbo as typeof fetch,
    async () => [{ ...naverGames[0], inning: 1, isTop: true, awayScore: 0, homeScore: 0 }],
    async () => ({ ...zeroEvidence, balls: 1, currentPitcher: "폰세", currentBatter: "빅터레이예스" }),
  );
  assert.equal(firstPitch.games[0].GAME_STATE_SC, "2");
  assert.equal(firstPitch.games[0].BALL_CN, 1);
  assert.equal(firstPitch.games[0].B_P_NM, "폰세");
  assert.equal(firstPitch.games[0].T_P_NM, "빅터레이예스");

  // 9) 양 소스 모두 실패 → ok:false (정상 "경기 0"과 구분).
  const bothFailed = await fetchKboLiveGames(
    "20260730",
    Date.now() + 2_000,
    failedKbo as typeof fetch,
    async () => { throw new Error("naver down"); },
  );
  assert.equal(bothFailed.ok, false);
  assert.deepEqual(bothFailed.games, []);

  // 10) actual GET /api/game-live: KBO 전면 실패(2026-07-30 204 장애 재현) 시에도
  //     5경기 전부 user-facing live 필드가 Naver relay 값으로 채워진다.
  await routeLevelRegression();
  await routeFailureMatrix();

  const gameLiveRoute = readFileSync("src/app/api/game-live/route.ts", "utf8");
  const gameEventsRoute = readFileSync("src/app/api/game-events/route.ts", "utf8");
  assert.match(gameLiveRoute, /fetchKboLiveGames\(date,/);
  assert.match(gameEventsRoute, /fetchKboLiveGames\(date,/);
  assert.doesNotMatch(gameLiveRoute, /GetKboGameList/);
  assert.doesNotMatch(gameEventsRoute, /GetKboGameList/);

  console.log("kbo-live-games-failover: actual-route matrix PASS");
}

// ---- actual route-level regression (mocked globalThis.fetch) ----

const SLATE = [
  { away: "HT", home: "SS", awayName: "KIA", homeName: "삼성", statusInfo: "2회말", pitcher: "네일", batter: "김지찬" },
  { away: "KT", home: "NC", awayName: "KT", homeName: "NC", statusInfo: "3회말", pitcher: "고영표", batter: "박민우" },
  { away: "LT", home: "HH", awayName: "롯데", homeName: "한화", statusInfo: "4회초", pitcher: "폰세", batter: "빅터레이예스" },
  { away: "OB", home: "SK", awayName: "두산", homeName: "SSG", statusInfo: "2회말", pitcher: "잭로그", batter: "최정" },
  { away: "WO", home: "LG", awayName: "키움", homeName: "LG", statusInfo: "3회말", pitcher: "로젠버그", batter: "홍창기" },
];

function naverSchedulePayload(date: string) {
  const naverDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  return {
    code: 200,
    success: true,
    result: {
      games: SLATE.map((g) => ({
        gameId: `${date}${g.away}${g.home}0${date.slice(0, 4)}`,
        gameDateTime: `${naverDate}T18:30:00`,
        stadium: "구장",
        awayTeamCode: g.away,
        homeTeamCode: g.home,
        awayTeamName: g.awayName,
        homeTeamName: g.homeName,
        awayTeamScore: 1,
        homeTeamScore: 0,
        statusCode: "STARTED",
        statusInfo: g.statusInfo,
      })),
    },
  };
}

function naverRelayPayload(pitcherName: string, batterName: string) {
  return {
    code: 200,
    success: true,
    result: {
      textRelayData: {
        inn: 3,
        currentGameState: {
          pitcher: "10001",
          batter: "20002",
          ball: "2",
          strike: "1",
          out: "1",
          base1: "7",
          base2: "0",
          base3: "4",
        },
        awayLineup: {
          batter: [{ pcode: "20002", name: batterName }],
          pitcher: [{ pcode: "30003", name: "다른투수" }],
        },
        homeLineup: {
          batter: [{ pcode: "40004", name: "다른타자" }],
          pitcher: [{ pcode: "10001", name: pitcherName }],
        },
        textRelays: [{
          title: "1회초",
          titleStyle: "8",
          textOptions: [{ seqno: 1, type: 1, pitchNum: 1, currentGameState: { ball: "0", strike: "1", out: "0" } }],
        }],
      },
    },
  };
}

async function routeLevelRegression() {
  const date = "20260730";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("Main.asmx")) return new Response(null, { status: 503 });
    if (url.includes("/api/games?")) {
      return Response.json({
        games: SLATE.map((g) => ({
          gameId: `${date}${g.away}${g.home}0`,
          awayStarterName: `${g.awayName}선발`,
          homeStarterName: `${g.homeName}선발`,
        })),
      });
    }
    if (url.includes("/relay?")) {
      const match = url.match(/schedule\/games\/(\d{8})([A-Z]{4})0\d{4}\/relay/);
      const slate = SLATE.find((g) => `${g.away}${g.home}` === match?.[2]);
      if (!slate) return new Response(null, { status: 404 });
      return Response.json(naverRelayPayload(slate.pitcher, slate.batter));
    }
    if (url.includes("api-gw.sports.naver.com/schedule/games?")) {
      return Response.json(naverSchedulePayload(date));
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    const { gameLiveRoute } = await import("../../src/app/api/game-live/route");
    const res = await gameLiveRoute(
      new NextRequest(`http://localhost/api/game-live?date=${date}`),
      { fetchKnownSlateIdsImpl: async () => SLATE.map((g) => `${date}${g.away}${g.home}0`) },
    );
    const body = await res.json() as {
      trace: { source: string; stage: string; deadlineAtMs: number };
      games: Array<{
        gameId: string; status: string; balls: number; strikes: number; outs: number;
        runner1b: boolean; runner2b: boolean; runner3b: boolean;
        currentPitcher: string | null; currentBatter: string | null;
        awayStarterName: string | null; homeStarterName: string | null;
      }>;
    };
    assert.equal(res.status, 200);
    assert.equal(body.trace.source, "naver");
    assert.equal(body.trace.stage, "starter-witness");
    assert.equal(res.headers.get("x-game-live-source"), "naver");
    assert.equal(res.headers.get("x-game-live-stage"), "starter-witness");
    assert.ok(Number(res.headers.get("x-game-live-deadline")) > Date.now());
    assert.equal(body.games.length, 5);
    for (const slate of SLATE) {
      const game = body.games.find((g) => g.gameId === `${date}${slate.away}${slate.home}0`);
      assert.ok(game, `route game missing: ${slate.away}${slate.home}`);
      assert.equal(game.status, "live");
      assert.equal(game.balls, 2, `${slate.away}${slate.home} balls`);
      assert.equal(game.strikes, 1, `${slate.away}${slate.home} strikes`);
      assert.equal(game.outs, 1, `${slate.away}${slate.home} outs`);
      assert.equal(game.runner1b, true);
      assert.equal(game.runner2b, false);
      assert.equal(game.runner3b, true);
      assert.equal(game.currentPitcher, slate.pitcher, `${slate.away}${slate.home} pitcher`);
      assert.equal(game.currentBatter, slate.batter, `${slate.away}${slate.home} batter`);
      assert.equal(game.awayStarterName, `${slate.awayName}선발`);
      assert.equal(game.homeStarterName, `${slate.homeName}선발`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

function abortableStall(signal?: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true },
    );
  });
}

async function withWatchdog<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: watchdog ${timeoutMs}ms exceeded`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function routeFailureMatrix() {
  const date = "20260730";
  const realFetch = globalThis.fetch;
  const { gameLiveRoute } = await import("../../src/app/api/game-live/route");
  const witnessGames = SLATE.map((g) => ({
    gameId: `${date}${g.away}${g.home}0`,
    awayStarterName: `${g.awayName}선발`,
    homeStarterName: `${g.homeName}선발`,
  }));

  const invoke = async (mode: "503" | "204" | "empty" | "timeout", naverMode: "ok" | "partial" | "timeout" | "fail") => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("Main.asmx")) {
        if (mode === "timeout") return abortableStall(init?.signal ?? undefined);
        if (mode === "empty") return Response.json({ game: [] });
        return new Response(null, { status: Number(mode) });
      }
      if (url.includes("/api/games?")) return Response.json({ games: witnessGames });
      if (url.includes("api-gw.sports.naver.com/schedule/games?")) {
        if (naverMode === "timeout") return abortableStall(init?.signal ?? undefined);
        if (naverMode === "fail") throw new Error("naver down");
        const payload = naverSchedulePayload(date);
        if (naverMode === "partial") payload.result.games.pop();
        return Response.json(payload);
      }
      if (url.includes("/relay?")) return Response.json(naverRelayPayload("투수", "타자"));
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;
    const startedAt = Date.now();
    const response = await withWatchdog(
      gameLiveRoute(
        new NextRequest(`http://localhost/api/game-live?date=${date}`),
        { fetchKnownSlateIdsImpl: async () => witnessGames.map((game) => game.gameId) },
      ),
      6_000,
      `KBO ${mode} / Naver ${naverMode}`,
    );
    const body = await response.json() as { games: unknown[]; trace: { stage: string; deadlineAtMs: number } };
    return { response, body, elapsedMs: Date.now() - startedAt };
  };

  try {
    for (const mode of ["503", "204", "empty", "timeout"] as const) {
      const result = await invoke(mode, "ok");
      assert.equal(result.response.status, 200, `KBO ${mode} -> Naver+witness`);
      assert.equal(result.body.games.length, 5, `KBO ${mode} full slate`);
      assert.ok(result.elapsedMs < 5_500, `KBO ${mode} deadline bound`);
    }

    // Scheduled slate is still subject to starter completeness. With KBO down
    // and both Naver views returning five games but zero starters, the route
    // must not emit the old silent HTTP 200 / starters 0-of-10 response.
    {
      let witnessCalls = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("Main.asmx")) return new Response(null, { status: 503 });
        if (url.includes("/api/games?")) {
          witnessCalls++;
          return Response.json({
            games: witnessGames.map((game) => ({
              ...game,
              awayStarterName: null,
              homeStarterName: null,
            })),
          });
        }
        if (url.includes("api-gw.sports.naver.com/schedule/games?")) {
          const payload = naverSchedulePayload(date);
          for (const game of payload.result.games) game.statusCode = "BEFORE";
          return Response.json(payload);
        }
        return realFetch(input as RequestInfo);
      }) as typeof fetch;
      const response = await withWatchdog(
        gameLiveRoute(
          new NextRequest(`http://localhost/api/game-live?date=${date}`),
          { fetchKnownSlateIdsImpl: async () => witnessGames.map((game) => game.gameId) },
        ),
        6_000,
        "scheduled 0/10 starters",
      );
      const body = await response.json() as { games: unknown[]; trace: { stage: string } };
      assert.equal(response.status, 503, "scheduled starters 0/10 fail closed");
      assert.equal(body.games.length, 0);
      assert.equal(body.trace.stage, "starter-witness-failed");
      assert.equal(witnessCalls, 1, "scheduled slate always calls witness");
    }

    // A structurally valid KBO 200 containing only 4/5 games must also compare
    // against the whole-day witness instead of bypassing it as authoritative.
    {
      let witnessCalls = 0;
      const partialKbo = SLATE.slice(0, 4).map((game) => ({
        G_ID: `${date}${game.away}${game.home}0`,
        GAME_STATE_SC: "1",
        CANCEL_SC_ID: "0",
        AWAY_NM: game.awayName,
        HOME_NM: game.homeName,
        T_PIT_P_NM: `${game.awayName}선발`,
        B_PIT_P_NM: `${game.homeName}선발`,
      }));
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("Main.asmx")) return Response.json({ game: partialKbo });
        if (url.includes("/api/games?")) {
          witnessCalls++;
          return Response.json({ games: witnessGames });
        }
        return realFetch(input as RequestInfo);
      }) as typeof fetch;
      const response = await withWatchdog(
        gameLiveRoute(
          new NextRequest(`http://localhost/api/game-live?date=${date}`),
          { fetchKnownSlateIdsImpl: async () => witnessGames.map((game) => game.gameId) },
        ),
        6_000,
        "KBO 200 partial 4/5",
      );
      const body = await response.json() as { games: unknown[]; trace: { stage: string } };
      assert.equal(response.status, 503, "KBO 4/5 slate fail closed");
      assert.equal(body.games.length, 0);
      assert.equal(body.trace.stage, "known-slate-mismatch");
      assert.equal(witnessCalls, 1, "KBO partial always calls witness");
    }

    // KBO/Naver and /api/games can degrade to the same 4/5 slate. The durable
    // five-game ledger must still reject that correlated partial response.
    {
      let knownSlateCalls = 0;
      const partialWitness = witnessGames.slice(0, 4);
      const partialKbo = SLATE.slice(0, 4).map((game) => ({
        G_ID: `${date}${game.away}${game.home}0`,
        GAME_STATE_SC: "1",
        CANCEL_SC_ID: "0",
        AWAY_NM: game.awayName,
        HOME_NM: game.homeName,
        T_PIT_P_NM: `${game.awayName}선발`,
        B_PIT_P_NM: `${game.homeName}선발`,
      }));
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("Main.asmx")) return Response.json({ game: partialKbo });
        if (url.includes("/api/games?")) return Response.json({ games: partialWitness });
        return realFetch(input as RequestInfo);
      }) as typeof fetch;
      const response = await withWatchdog(
        gameLiveRoute(
          new NextRequest(`http://localhost/api/game-live?date=${date}`),
          {
            fetchKnownSlateIdsImpl: async () => {
              knownSlateCalls++;
              return witnessGames.map((game) => game.gameId);
            },
          },
        ),
        6_000,
        "correlated partial 4/5",
      );
      const body = await response.json() as { games: unknown[]; trace: { stage: string } };
      assert.equal(response.status, 503, "correlated 4/5 slate fails closed");
      assert.equal(body.games.length, 0);
      assert.equal(body.trace.stage, "known-slate-mismatch");
      assert.equal(knownSlateCalls, 1, "durable known slate always queried");
    }

    // Source cleanup is part of the route contract too. A KBO primary that
    // delays abort settlement must reach active=0 before Naver success returns.
    {
      let activeKbo = 0;
      let kboSignal: AbortSignal | undefined;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("Main.asmx")) {
          activeKbo++;
          kboSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              setTimeout(() => {
                activeKbo--;
                reject(new DOMException("aborted", "AbortError"));
              }, 60);
            }, { once: true });
          });
        }
        if (url.includes("/api/games?")) return Response.json({ games: witnessGames });
        if (url.includes("api-gw.sports.naver.com/schedule/games?")) {
          return Response.json(naverSchedulePayload(date));
        }
        if (url.includes("/relay?")) return Response.json(naverRelayPayload("투수", "타자"));
        return realFetch(input as RequestInfo, init);
      }) as typeof fetch;
      const startedAt = Date.now();
      const response = await withWatchdog(
        gameLiveRoute(
          new NextRequest(`http://localhost/api/game-live?date=${date}`),
          { fetchKnownSlateIdsImpl: async () => witnessGames.map((game) => game.gameId) },
        ),
        6_000,
        "delayed KBO abort cleanup",
      );
      const elapsedMs = Date.now() - startedAt;
      assert.equal(response.status, 200, "Naver succeeds after delayed KBO abort");
      assert.ok(elapsedMs < 5_000, `delayed KBO cleanup stays inside hard edge: ${elapsedMs}ms`);
      assert.equal(kboSignal?.aborted, true, "KBO source receives deadline abort");
      assert.equal(activeKbo, 0, "KBO source settled before response");
    }

    // Reserve witness/DB time before sources start. A late Naver source must
    // abort and fully settle inside that reserved slice, not consume all 5s.
    {
      let activeNaver = 0;
      let naverSignal: AbortSignal | undefined;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("Main.asmx")) return new Response(null, { status: 503 });
        if (url.includes("api-gw.sports.naver.com/schedule/games?")) {
          activeNaver++;
          naverSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              setTimeout(() => {
                activeNaver--;
                reject(new DOMException("aborted", "AbortError"));
              }, 60);
            }, { once: true });
          });
        }
        return realFetch(input as RequestInfo, init);
      }) as typeof fetch;
      const startedAt = Date.now();
      const response = await withWatchdog(
        gameLiveRoute(
          new NextRequest(`http://localhost/api/game-live?date=${date}`),
          { fetchKnownSlateIdsImpl: async () => witnessGames.map((game) => game.gameId) },
        ),
        6_000,
        "late Naver source reserved witness budget",
      );
      const body = await response.json() as { games: unknown[]; trace: { stage: string } };
      const elapsedMs = Date.now() - startedAt;
      assert.equal(response.status, 503, "late Naver source fails closed");
      assert.equal(body.trace.stage, "dual-fail");
      assert.equal(body.games.length, 0);
      assert.ok(elapsedMs < 4_800, `source settles before witness reserve: ${elapsedMs}ms`);
      assert.equal(naverSignal?.aborted, true, "late Naver source receives abort");
      assert.equal(activeNaver, 0, "late Naver source settled before response");
    }

    // Post-merge P0 regression: a fast durable-ledger failure must abort and
    // settle the concurrent actual /api/games witness before the 503 response.
    // Promise.all fail-fast previously returned while this fetch stayed active.
    {
      let activeWitness = 0;
      let witnessSignal: AbortSignal | undefined;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("Main.asmx")) {
          return Response.json({
            game: SLATE.map((game) => ({
              G_ID: `${date}${game.away}${game.home}0`,
              GAME_STATE_SC: "1",
              CANCEL_SC_ID: "0",
              AWAY_NM: game.awayName,
              HOME_NM: game.homeName,
              T_PIT_P_NM: `${game.awayName}선발`,
              B_PIT_P_NM: `${game.homeName}선발`,
            })),
          });
        }
        if (url.includes("/api/games?")) {
          activeWitness++;
          witnessSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              setTimeout(() => {
                activeWitness--;
                reject(new DOMException("aborted", "AbortError"));
              }, 20);
            }, { once: true });
          });
        }
        return realFetch(input as RequestInfo, init);
      }) as typeof fetch;
      const response = await withWatchdog(
        gameLiveRoute(
          new NextRequest(`http://localhost/api/game-live?date=${date}`),
          {
            fetchKnownSlateIdsImpl: async () => {
              throw new Error("known slate DB failed");
            },
          },
        ),
        6_000,
        "known-slate fast failure aborts witness",
      );
      assert.equal(response.status, 503, "known-slate failure stays fail-closed");
      assert.equal(witnessSignal?.aborted, true, "witness shares failure abort signal");
      assert.equal(activeWitness, 0, "witness settled before response");
    }

    // Production 14:14 intermittent shape: the source and durable slate are
    // healthy, but the actual /api/games witness stalls until the route budget.
    // The request must fail closed without leaking that self-fetch afterward.
    {
      let activeWitness = 0;
      let witnessSignal: AbortSignal | undefined;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("Main.asmx")) {
          return Response.json({
            game: SLATE.map((game) => ({
              G_ID: `${date}${game.away}${game.home}0`,
              GAME_STATE_SC: "1",
              CANCEL_SC_ID: "0",
              AWAY_NM: game.awayName,
              HOME_NM: game.homeName,
              T_PIT_P_NM: `${game.awayName}선발`,
              B_PIT_P_NM: `${game.homeName}선발`,
            })),
          });
        }
        if (url.includes("/api/games?")) {
          activeWitness++;
          witnessSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              setTimeout(() => {
                activeWitness--;
                reject(new DOMException("aborted", "AbortError"));
              }, 60);
            }, { once: true });
          });
        }
        return realFetch(input as RequestInfo, init);
      }) as typeof fetch;
      const startedAt = Date.now();
      const response = await withWatchdog(
        gameLiveRoute(
          new NextRequest(`http://localhost/api/game-live?date=${date}`),
          { fetchKnownSlateIdsImpl: async () => witnessGames.map((game) => game.gameId) },
        ),
        6_000,
        "actual witness deadline stall",
      );
      const body = await response.json() as { games: unknown[]; trace: { stage: string } };
      const elapsedMs = Date.now() - startedAt;
      assert.equal(response.status, 503, "witness stall fails closed");
      assert.equal(body.trace.stage, "starter-witness-failed");
      assert.equal(body.games.length, 0, "witness stall exposes no partial slate");
      assert.ok(elapsedMs < 5_000, `witness settles before hard deadline: ${elapsedMs}ms`);
      assert.equal(witnessSignal?.aborted, true, "deadline abort reaches actual witness");
      assert.equal(activeWitness, 0, "deadline witness settled before response");
    }

    // The symmetric DB shape must also await delayed PostgREST abort cleanup,
    // rather than letting a deadline wrapper false-settle before raw I/O.
    {
      let activeDb = 0;
      let dbSignal: AbortSignal | undefined;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("Main.asmx")) {
          return Response.json({
            game: SLATE.map((game) => ({
              G_ID: `${date}${game.away}${game.home}0`,
              GAME_STATE_SC: "1",
              CANCEL_SC_ID: "0",
              AWAY_NM: game.awayName,
              HOME_NM: game.homeName,
              T_PIT_P_NM: `${game.awayName}선발`,
              B_PIT_P_NM: `${game.homeName}선발`,
            })),
          });
        }
        if (url.includes("/api/games?")) return Response.json({ games: witnessGames });
        return realFetch(input as RequestInfo);
      }) as typeof fetch;
      const startedAt = Date.now();
      const response = await withWatchdog(
        gameLiveRoute(
          new NextRequest(`http://localhost/api/game-live?date=${date}`),
          {
            fetchKnownSlateIdsImpl: async (_date, _deadlineAtMs, signal) => {
              activeDb++;
              dbSignal = signal;
              return new Promise<string[]>((_resolve, reject) => {
                signal.addEventListener("abort", () => {
                  setTimeout(() => {
                    activeDb--;
                    reject(new DOMException("aborted", "AbortError"));
                  }, 60);
                }, { once: true });
              });
            },
          },
        ),
        6_000,
        "actual DB deadline stall",
      );
      const body = await response.json() as { games: unknown[]; trace: { stage: string } };
      const elapsedMs = Date.now() - startedAt;
      assert.equal(response.status, 503, "DB stall fails closed");
      assert.equal(body.trace.stage, "starter-witness-failed");
      assert.equal(body.games.length, 0, "DB stall exposes no partial slate");
      assert.ok(elapsedMs < 5_000, `DB settles before hard deadline: ${elapsedMs}ms`);
      assert.equal(dbSignal?.aborted, true, "soft deadline abort reaches actual DB query");
      assert.equal(activeDb, 0, "delayed DB abort settled before response");
    }

    const partial = await invoke("503", "partial");
    assert.equal(partial.response.status, 503, "Naver partial must fail closed");
    assert.equal(partial.body.games.length, 0);
    assert.equal(partial.body.trace.stage, "known-slate-mismatch");

    const naverTimeout = await invoke("503", "timeout");
    assert.equal(naverTimeout.response.status, 503, "Naver timeout must fail closed");
    assert.equal(naverTimeout.body.trace.stage, "dual-fail");
    assert.ok(naverTimeout.elapsedMs < 5_500, "Naver timeout absolute deadline");

    const dualFail = await invoke("503", "fail");
    assert.equal(dualFail.response.status, 503, "dual fail must fail closed");
    assert.equal(dualFail.body.trace.stage, "dual-fail");

    // A same-source empty witness cannot prove an off-day. The durable
    // game_notify_state slate is independent evidence that five games existed,
    // so KBO failure/empty + Naver empty + /api/games empty must never become
    // the old false-green HTTP 200 games=[].
    for (const mode of ["503", "204", "empty", "timeout"] as const) {
      let active = 0;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("Main.asmx")) {
          if (mode === "timeout") {
            active++;
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                active--;
                reject(new DOMException("aborted", "AbortError"));
              }, { once: true });
            });
          }
          if (mode === "empty") return Response.json({ game: [] });
          return new Response(null, { status: Number(mode) });
        }
        if (url.includes("api-gw.sports.naver.com/schedule/games?")) {
          return Response.json({ code: 200, success: true, result: { games: [] } });
        }
        if (url.includes("/api/games?")) return Response.json({ games: [] });
        return realFetch(input as RequestInfo, init);
      }) as typeof fetch;
      const response = await withWatchdog(
        gameLiveRoute(
          new NextRequest(`http://localhost/api/game-live?date=${date}`),
          { fetchKnownSlateIdsImpl: async () => witnessGames.map((game) => game.gameId) },
        ),
        6_000,
        `known-slate KBO ${mode} / Naver empty`,
      );
      const body = await response.json() as { games: unknown[]; trace: { stage: string } };
      assert.equal(response.status, 503, `known slate KBO ${mode} must fail closed`);
      assert.equal(body.games.length, 0);
      assert.equal(body.trace.stage, "known-slate-mismatch");
      assert.equal(active, 0, `known slate KBO ${mode} outstanding 0`);
    }

    // Without independent durable evidence, a dual-empty off-day remains a
    // valid empty slate rather than manufacturing an outage.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("Main.asmx")) return Response.json({ game: [] });
      if (url.includes("api-gw.sports.naver.com/schedule/games?")) {
        return Response.json({ code: 200, success: true, result: { games: [] } });
      }
      if (url.includes("/api/games?")) return Response.json({ games: [] });
      return realFetch(input as RequestInfo);
    }) as typeof fetch;
    const offday = await gameLiveRoute(
      new NextRequest(`http://localhost/api/game-live?date=${date}`),
      { fetchKnownSlateIdsImpl: async () => [] },
    );
    assert.equal(offday.status, 200, "no durable slate evidence permits authoritative off-day");
    assert.deepEqual((await offday.json() as { games: unknown[] }).games, []);
  } finally {
    globalThis.fetch = realFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
