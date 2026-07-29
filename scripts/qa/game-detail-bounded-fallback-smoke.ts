/**
 * actual GET /api/game-detail bounded dual-source regression.
 *
 * KBO/Naver 조합별 실제 route handler를 호출해 HTTP 200 partial, canonical status,
 * linescore/boxScore, lineup graceful-null, 단일 절대 deadline signal을 고정한다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

const GAME_ID = "20260729WOLG0";
const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
const timeoutRequests: number[] = [];
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "smoke-service-role-key";

// 실제 production 상한 값은 그대로 검증하되 smoke wall time만 80ms로 축소한다.
AbortSignal.timeout = ((ms: number) => {
  timeoutRequests.push(ms);
  return nativeTimeout(80);
}) as typeof AbortSignal.timeout;

let GET: typeof import("../../src/app/api/game-detail/route").GET;
let USER_FACING_GAME_DETAIL_DEADLINE_MS: number;
let setDegradationObserver:
  typeof import("../../src/app/api/game-detail/route").setGameDetailDegradationObserverForTest;

type SourceMode = "normal" | "partial" | "blackhole" | "http-error" | "sr-retry-blackhole";
type GameState = "scheduled" | "live" | "final" | "cancelled";

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function cells(values: unknown[]) {
  return values.map((Text) => ({ Text: String(Text) }));
}

function scoreboard(state: GameState) {
  if (state === "scheduled" || state === "cancelled") {
    return [[{
      STADIUM_NM: "잠실",
      GAME_START_TM: "18:30",
      CANCEL_SC_NM: state === "cancelled" ? "우천취소" : "",
      T_SCORE_CN: "0",
      B_SCORE_CN: "0",
    }]];
  }
  const away = [0, 1, 0, 0, 0, 0, 2, 0, 0];
  const home = [0, 0, 0, 2, 0, 0, 0, 0, state === "live" ? "-" : 0];
  return [
    [{
      STADIUM_NM: "잠실",
      GAME_START_TM: "18:30",
      END_TM: state === "final" ? "21:20" : "",
      T_SCORE_CN: "3",
      B_SCORE_CN: "2",
    }],
    [JSON.stringify({
      rows: [
        { row: cells(["", "키움", ...away, 3, 7, 0, 2]) },
        { row: cells(["", "LG", ...home, 2, 6, 1, 3]) },
      ],
    })],
  ];
}

function lineup() {
  const side = (name: string) => [JSON.stringify({
    rows: [{ row: cells([1, "중견수", name, "1.2"]) }],
  })];
  return [[{ LINEUP_CK: true }], [], [], side("홍길동"), side("김선수")];
}

function pitcher(name: string) {
  return cells([name, "선발", "승", 0, 0, 0, "9", 31, 102, 30, 6, 0, 2, 8, 2, 2, "2.00"]);
}

function boxScore() {
  return {
    tables: [
      { rows: [] },
      { rows: [{ row: cells([1, "중", "김선수", 4, 2, 1, 1, ".500"]) }] },
      { rows: [{ row: cells([1, "중", "홍길동", 4, 1, 1, 0, ".250"]) }] },
      { rows: [{ row: pitcher("원정투수") }] },
      { rows: [{ row: pitcher("홈투수") }] },
    ],
  };
}

function kboList(state: GameState) {
  const stateCode =
    state === "final" ? "3" :
    state === "live" ? "2" :
    "1";
  return {
    game: [{
      G_ID: GAME_ID,
      G_DT: "20260729",
      G_TM: "18:30",
      S_NM: "잠실",
      AWAY_ID: "WO",
      HOME_ID: "LG",
      AWAY_NM: "키움",
      HOME_NM: "LG",
      T_SCORE_CN: "3",
      B_SCORE_CN: "2",
      GAME_INN_NO: state === "live" ? 8 : state === "final" ? 9 : 0,
      GAME_TB_SC: "T",
      GAME_STATE_SC: stateCode,
      CANCEL_SC_ID: state === "cancelled" ? "1" : "",
      T_PIT_P_NM: "",
      B_PIT_P_NM: "",
      W_PIT_P_NM: "",
      L_PIT_P_NM: "",
      SV_PIT_P_NM: "",
      STRIKE_CN: 0,
      BALL_CN: 0,
      OUT_CN: 0,
      B1_BAT_ORDER_NO: 0,
      B2_BAT_ORDER_NO: 0,
      B3_BAT_ORDER_NO: 0,
      B_P_NM: "",
      T_P_NM: "",
      T_RANK_NO: 1,
      B_RANK_NO: 2,
      TV_IF: "SPOTV",
    }],
  };
}

function naverSchedule(state: GameState) {
  return {
    code: 200,
    success: true,
    result: {
      games: [{
        gameId: `${GAME_ID}2026`,
        gameDateTime: "2026-07-29T18:30:00",
        stadium: "잠실",
        awayTeamCode: "WO",
        homeTeamCode: "LG",
        awayTeamName: "키움",
        homeTeamName: "LG",
        awayTeamScore: 3,
        homeTeamScore: 2,
        statusCode:
          state === "final" ? "RESULT" :
          state === "live" ? "STARTED" :
          state === "cancelled" ? "CANCEL" :
          "READY",
        statusInfo:
          state === "final" ? "경기종료" :
          state === "live" ? "8회초" :
          state === "cancelled" ? "우천취소" :
          "경기전",
        cancel: state === "cancelled",
      }],
    },
  };
}

function naverRecord(state: GameState) {
  if (state === "scheduled" || state === "cancelled") {
    return { result: { recordData: {} } };
  }
  const batter = (name: string) => ({
    batOrder: 1, pos: "중", name, ab: 4, hit: 2, run: 1, rbi: 1,
    hr: 0, h2: 0, h3: 0, bb: 0, kk: 1, sb: 0, hra: ".500",
  });
  const pitcherRow = (name: string) => ({
    name, inn: "9", wls: "승", hit: 6, r: 2, hr: 0, kk: 8,
    bb: 2, er: 2, pa: 31, ab: 30, era: "2.00",
  });
  return {
    result: {
      recordData: {
        battersBoxscore: { away: [batter("김선수")], home: [batter("홍길동")] },
        pitchersBoxscore: { away: [pitcherRow("원정투수")], home: [pitcherRow("홈투수")] },
        scoreBoard: {
          inn: {
            away: [0, 1, 0, 0, 0, 0, 2, 0, 0],
            home: [0, 0, 0, 2, 0, 0, 0, 0, 0],
          },
          rheb: {
            away: { r: 3, h: 7, e: 0 },
            home: { r: 2, h: 6, e: 1 },
          },
        },
      },
    },
  };
}

function blackhole(signal?: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException("deadline", "TimeoutError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function scenario(
  name: string,
  kboMode: SourceMode,
  naverMode: "normal" | "blackhole",
  state: GameState,
) {
  const signals = new Set<AbortSignal>();
  const srIds: string[] = [];
  const degradationEvents: Array<{ apiName: string; reason: string }> = [];
  setDegradationObserver((event) => degradationEvents.push(event));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.signal) signals.add(init.signal);

    const isKbo = url.includes("koreabaseball.com");
    if (isKbo && kboMode === "blackhole") return blackhole(init?.signal ?? undefined);
    if (isKbo && kboMode === "http-error") return new Response("upstream unavailable", { status: 503 });
    if (!isKbo && naverMode === "blackhole") return blackhole(init?.signal ?? undefined);

    if (url.includes("GetKboGameList")) {
      // partial-schema scenario intentionally disagrees with Naver canonical status.
      return json(kboList(kboMode === "partial" ? "live" : state));
    }
    if (url.includes("GetScoreBoard")) {
      const srId = new URLSearchParams(String(init?.body)).get("srId") ?? "";
      srIds.push(srId);
      if (kboMode === "sr-retry-blackhole" && srId === "1") {
        return blackhole(init?.signal ?? undefined);
      }
      if (kboMode === "sr-retry-blackhole" && srId === "0") return json([]);
      if (kboMode === "partial") return json([[{ STADIUM_NM: "잠실", END_TM: "21:20" }]]);
      return json(scoreboard(state));
    }
    if (url.includes("GetLineUpAnalysis")) {
      if (
        kboMode === "partial" ||
        kboMode === "sr-retry-blackhole" ||
        state === "scheduled" ||
        state === "cancelled"
      ) return json([]);
      return json(lineup());
    }
    if (url.includes("GetBoxScore")) {
      if (
        kboMode === "partial" ||
        kboMode === "sr-retry-blackhole" ||
        state === "scheduled" ||
        state === "cancelled"
      ) return json({ tables: [] });
      return json(boxScore());
    }
    if (url.includes("/record")) return json(naverRecord(state));
    if (url.includes("/relay?")) {
      return json({ result: { textRelayData: { inn: 1, textRelays: [] } } });
    }
    if (url.includes("api-gw.sports.naver.com/schedule/games")) {
      return json(naverSchedule(state));
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const timeoutOffset = timeoutRequests.length;
  const started = performance.now();
  const keepAlive = setTimeout(() => {}, 1000);
  const response = await GET(new NextRequest(`https://keubo.fan/api/game-detail?gameId=${GAME_ID}`));
  clearTimeout(keepAlive);
  const elapsed = performance.now() - started;
  const body = await response.json();
  setDegradationObserver(null);

  assert.equal(response.status, 200, `${name}: HTTP 200`);
  assert.ok(elapsed < 500, `${name}: bounded wall time (${elapsed.toFixed(1)}ms)`);
  assert.deepEqual(
    timeoutRequests.slice(timeoutOffset),
    [USER_FACING_GAME_DETAIL_DEADLINE_MS],
    `${name}: absolute deadline SSOT 1회`,
  );
  assert.equal(signals.size, 1, `${name}: 모든 upstream이 동일 AbortSignal 공유`);
  return { body, srIds, degradationEvents };
}

async function main() {
  const route = await import("../../src/app/api/game-detail/route");
  GET = route.GET;
  USER_FACING_GAME_DETAIL_DEADLINE_MS = route.USER_FACING_GAME_DETAIL_DEADLINE_MS;
  setDegradationObserver = route.setGameDetailDegradationObserverForTest;

  const kboDown = await scenario("KBO 3종 blackhole + Naver final", "blackhole", "normal", "final");
  assert.equal(kboDown.body.status, "final");
  assert.equal(kboDown.body.linescore.away.R, 3);
  assert.equal(kboDown.body.boxScore.awayBatters[0].name, "김선수");
  assert.equal(kboDown.body.lineup, null);
  assert.deepEqual(kboDown.degradationEvents, [{ apiName: "kbo-game-detail", reason: "timeout" }]);

  const kboDownLive = await scenario("KBO 3종 blackhole + Naver live", "blackhole", "normal", "live");
  assert.equal(kboDownLive.body.status, "live");
  assert.equal(kboDownLive.body.linescore.home.R, 2);
  assert.ok(kboDownLive.body.boxScore.homeBatters.length > 0);
  assert.equal(kboDownLive.body.lineup, null);
  assert.deepEqual(kboDownLive.degradationEvents, [{ apiName: "kbo-game-detail", reason: "timeout" }]);

  const naverDown = await scenario("KBO normal + Naver blackhole", "normal", "blackhole", "final");
  assert.equal(naverDown.body.status, "final");
  assert.equal(naverDown.body.linescore.away.R, 3);
  assert.ok(naverDown.body.boxScore.awayBatters.length > 0);
  assert.ok(naverDown.body.lineup?.away.length > 0);
  assert.equal(naverDown.degradationEvents.length, 0);

  const partial = await scenario("KBO partial schema + Naver normal", "partial", "normal", "final");
  assert.equal(partial.body.status, "final");
  assert.equal(partial.body.linescore.away.R, 3);
  assert.ok(partial.body.boxScore.awayBatters.length > 0);
  assert.equal(partial.body.lineup, null);
  assert.deepEqual(partial.degradationEvents, [{ apiName: "kbo-game-detail", reason: "schema-error" }]);

  const bothDown = await scenario("KBO + Naver blackhole", "blackhole", "blackhole", "final");
  assert.equal(bothDown.body.status, "scheduled");
  assert.equal(bothDown.body.linescore, null);
  assert.equal(bothDown.body.boxScore, null);
  assert.equal(bothDown.body.lineup, null);
  assert.deepEqual(
    bothDown.degradationEvents,
    [{ apiName: "game-detail-dual-source-outage", reason: "timeout" }],
  );

  const retry = await scenario("srId 0 empty → 1 blackhole", "sr-retry-blackhole", "normal", "final");
  assert.deepEqual(retry.srIds.filter((v) => v === "0" || v === "1"), ["0", "1"]);
  assert.equal(retry.body.status, "final");
  assert.equal(retry.body.lineup, null);
  assert.deepEqual(retry.degradationEvents, [{ apiName: "kbo-game-detail", reason: "timeout" }]);

  const httpError = await scenario("KBO HTTP 503 + Naver normal", "http-error", "normal", "final");
  assert.equal(httpError.body.status, "final");
  assert.deepEqual(
    httpError.degradationEvents,
    [{ apiName: "kbo-game-detail", reason: "http-error" }],
  );

  const scheduled = await scenario("normal scheduled", "normal", "normal", "scheduled");
  assert.equal(scheduled.body.status, "scheduled");
  assert.equal(scheduled.body.linescore, null);
  assert.equal(scheduled.body.boxScore, null);
  assert.equal(scheduled.degradationEvents.length, 0);

  const cancelled = await scenario("normal cancelled", "normal", "normal", "cancelled");
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(cancelled.body.linescore, null);
  assert.equal(cancelled.body.boxScore, null);
  assert.equal(cancelled.degradationEvents.length, 0);

  // mutation guard: 후속 fetchGames() 기본 10초 경로가 route에 재유입되면 즉시 red.
  const routeSource = readFileSync("src/app/api/game-detail/route.ts", "utf8");
  assert.doesNotMatch(routeSource, /\bfetchGames\s*\(/, "route must not reintroduce fetchGames 10s await");
  assert.match(routeSource, /signal:\s*deadlineSignal/g, "shared absolute deadline wiring retained");

  console.log("game-detail bounded fallback: 9 actual GET + degradation scenarios PASS");
}

main()
  .finally(() => {
    AbortSignal.timeout = nativeTimeout as typeof AbortSignal.timeout;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
