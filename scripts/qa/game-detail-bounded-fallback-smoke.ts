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

type SourceMode =
  | "normal"
  | "partial"
  | "blackhole"
  | "http-error"
  | "no-content"
  | "empty"
  | "sr-retry-blackhole"
  | "detail-schema-error"
  | "detail-http-error"
  | "detail-timeout"
  | "list-http-error"
  | "pitch-zero";
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

function boxScore(pitchCount = 102) {
  return {
    tables: [
      { rows: [] },
      { rows: [{ row: cells([1, "중", "김선수", 4, 2, 1, 1, ".500"]) }] },
      { rows: [{ row: cells([1, "중", "홍길동", 4, 1, 1, 0, ".250"]) }] },
      { rows: [{ row: cells(["원정투수", "선발", "승", 0, 0, 0, "9", 31, pitchCount, 30, 6, 0, 2, 8, 2, 2, "2.00"]) }] },
      { rows: [{ row: cells(["홈투수", "선발", "승", 0, 0, 0, "9", 31, pitchCount, 30, 6, 0, 2, 8, 2, 2, "2.00"]) }] },
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
        broadChannel: "KBS N SPORTS",
      }],
    },
  };
}

function naverPreview(state: GameState) {
  const gameInfo = {
    gdate: "20260729",
    aCode: "WO",
    hCode: "LG",
  };
  // 라인업 미확정 scheduled는 실측대로 선발투수 1명만 먼저 내려온다.
  if (state === "scheduled") {
    return {
      code: 200,
      success: true,
      result: {
        previewData: {
          gameInfo,
          awayTeamLineUp: {
            fullLineUp: [{ positionName: "선발투수", playerName: "원정투수" }],
          },
          homeTeamLineUp: {
            fullLineUp: [{ positionName: "선발투수", playerName: "홈투수" }],
          },
        },
      },
    };
  }
  if (state === "cancelled") {
    return {
      code: 200,
      success: true,
      result: {
        previewData: {
          gameInfo,
          awayTeamLineUp: { fullLineUp: [] },
          homeTeamLineUp: { fullLineUp: [] },
        },
      },
    };
  }
  const POSITIONS = ["중견수", "유격수", "지명타자", "1루수", "우익수", "좌익수", "3루수", "포수", "2루수"];
  const side = (prefix: string, sp: string) => ({
    fullLineUp: [
      { positionName: "선발투수", playerName: sp },
      ...POSITIONS.map((positionName, i) => ({ positionName, playerName: `${prefix}${i + 1}` })),
    ],
  });
  return {
    code: 200,
    success: true,
    result: {
      previewData: {
        gameInfo,
        awayTeamLineUp: side("원정타자", "원정투수"),
        homeTeamLineUp: side("홈타자", "홈투수"),
      },
    },
  };
}

function naverRecord(state: GameState) {
  if (state === "scheduled" || state === "cancelled") {
    return { result: { recordData: {} } };
  }
  const batter = (name: string, order: number) => ({
    batOrder: order, pos: "중", name, ab: 4, hit: name === "김선수" ? 1 : 2, run: 1, rbi: 1,
    hr: 0, h2: null, h3: null, bb: 0, kk: 1, sb: 0, hra: ".500",
    inn4: name === "김선수" ? "좌2" : "중안",
  });
  const pitcherRow = (name: string) => ({
    name, inn: "9", wls: "승", hit: 6, r: 2, hr: 0, kk: 8,
    bb: 2, bbhp: 2, bf: 102, er: 2, pa: 31, ab: 30, era: "2.00",
  });
  return {
    result: {
      recordData: {
        battersBoxscore: {
          away: Array.from({ length: 9 }, (_, index) => batter(index === 0 ? "김선수" : `원정타자${index + 1}`, index + 1)),
          home: Array.from({ length: 9 }, (_, index) => batter(index === 0 ? "홍길동" : `홈타자${index + 1}`, index + 1)),
        },
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
  naverMode:
    | "normal"
    | "blackhole"
    | "partial"
    | "preview-only"
    | "preview-partial"
    | "bf-zero"
    | "bf-missing"
    | "bf-hidden-row",
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
    if (isKbo && kboMode === "no-content") return new Response(null, { status: 204 });
    const isKboList = url.includes("GetKboGameList");
    if (isKbo && kboMode === "detail-timeout" && !isKboList) {
      return blackhole(init?.signal ?? undefined);
    }
    if (isKbo && kboMode === "detail-http-error" && !isKboList) {
      return new Response("upstream unavailable", { status: 503 });
    }
    if (isKbo && kboMode === "list-http-error" && isKboList) {
      return new Response("upstream unavailable", { status: 503 });
    }
    // 상세 3종만 HTTP 200 + 비JSON(HTML) — 경기목록은 정상. 실측된 예정경기 오탐 패턴.
    if (
      isKbo &&
      kboMode === "detail-schema-error" &&
      !isKboList
    ) {
      return new Response("<html>KBO error page</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
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
      if (kboMode === "empty") return json([]);
      return json(scoreboard(state));
    }
    if (url.includes("GetLineUpAnalysis")) {
      if (
        kboMode === "empty" ||
        kboMode === "partial" ||
        kboMode === "sr-retry-blackhole" ||
        state === "scheduled" ||
        state === "cancelled"
      ) return json([]);
      return json(lineup());
    }
    if (url.includes("GetBoxScore")) {
      if (
        kboMode === "empty" ||
        kboMode === "partial" ||
        kboMode === "sr-retry-blackhole" ||
        state === "scheduled" ||
        state === "cancelled"
      ) return json({ tables: [] });
      return json(boxScore(kboMode === "pitch-zero" ? 0 : 102));
    }
    if (url.includes("/record")) {
      if (naverMode === "bf-hidden-row") {
        const payload = naverRecord(state) as {
          result: { recordData: { pitchersBoxscore: { away: Array<Record<string, unknown>> } } };
        };
        payload.result.recordData.pitchersBoxscore.away.push({ name: "", inn: "1", bf: 0 });
        return json(payload);
      }
      if (naverMode === "bf-zero" || naverMode === "bf-missing") {
        const payload = JSON.parse(JSON.stringify(
          naverRecord(state),
          (key, value) => key === "bf" ? (naverMode === "bf-zero" ? 0 : undefined) : value,
        ));
        return json(payload);
      }
      if (naverMode === "partial") {
        const payload = naverRecord(state) as {
          result?: { recordData?: { battersBoxscore?: { away?: unknown[]; home?: unknown[] } } };
        };
        const recordData = payload.result?.recordData;
        if (recordData?.battersBoxscore) recordData.battersBoxscore.home = [];
        return json(payload);
      }
      return json(naverRecord(state));
    }
    if (url.includes("/preview")) {
      if (naverMode === "preview-only" || naverMode === "preview-partial") {
        const preview = naverPreview("scheduled") as {
          result: { previewData: { homeTeamLineUp: { fullLineUp: unknown[] } } };
        };
        if (naverMode === "preview-partial") {
          preview.result.previewData.homeTeamLineUp.fullLineUp = [];
        }
        return json(preview);
      }
      return json(naverPreview(state));
    }
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
  // KBO GetLineUpAnalysis 열화 → Naver preview 라인업으로 표시 폴백(isToday=true 게이트 통과).
  assert.equal(kboDown.body.lineup?.isToday, true);
  assert.equal(kboDown.body.lineup?.away.length, 9);
  assert.equal(kboDown.body.lineup?.home.length, 9);
  assert.equal(kboDown.body.lineup?.away[0].name, "원정타자1");
  assert.equal(kboDown.body.lineup?.away[0].position, "CF");
  assert.equal(kboDown.body.lineup?.away[0].order, 1);
  // 선발투수는 타순 엔트리에서 제외하되 버리지 않고 awayStarter/homeStarter 로 보존(삼순 PR#988 P0-1).
  assert.ok(
    !kboDown.body.lineup?.away.some((e: { name: string }) => e.name === "원정투수"),
    "선발투수는 타순 엔트리에서 제외",
  );
  assert.equal(kboDown.body.lineup?.awayStarter, "원정투수", "Naver 폴백 선발투수(원정) 보존");
  assert.equal(kboDown.body.lineup?.homeStarter, "홈투수", "Naver 폴백 선발투수(홈) 보존");
  assert.equal(kboDown.body.trace?.lineupSource, "naver-confirmed");
  assert.equal(kboDown.body.trace?.boxScoreSource, "naver");
  assert.ok(kboDown.body.boxScore.awayPitchers[0].pitchCount > 0, "Naver bf로 pitchCount 복구");
  assert.equal(
    kboDown.body.meta.broadcastChannels?.[0]?.name,
    "KBS N SPORTS",
    "KBO list blackhole → Naver broadChannel 복구",
  );
  assert.deepEqual(kboDown.degradationEvents, [{ apiName: "kbo-game-detail", reason: "timeout" }]);

  const kboDownLive = await scenario("KBO 3종 blackhole + Naver live", "blackhole", "normal", "live");
  assert.equal(kboDownLive.body.status, "live");
  assert.equal(kboDownLive.body.linescore.home.R, 2);
  assert.ok(kboDownLive.body.boxScore.homeBatters.length > 0);
  assert.equal(kboDownLive.body.lineup?.isToday, true);
  assert.equal(kboDownLive.body.lineup?.home.length, 9);
  assert.equal(kboDownLive.body.lineup?.awayStarter, "원정투수");
  assert.equal(kboDownLive.body.lineup?.homeStarter, "홈투수");
  assert.deepEqual(kboDownLive.degradationEvents, [{ apiName: "kbo-game-detail", reason: "timeout" }]);
  assert.equal(kboDownLive.body.boxScore.awayBatters[0].h2b, 1, "record inn4=좌2 → h2b=1");

  // 실제 GET의 Naver record box를 celebration diff에 연결해 relay와 동일 semantic id인지 고정.
  const [{ generateEvents }, { generateRelayEvents }] = await Promise.all([
    import("../../src/lib/event-generator"),
    import("../../src/lib/relay-event-generator"),
  ]);
  const live = {
    gameId: GAME_ID,
    isLive: true,
    inning: 8,
    isTop: true,
    balls: 0,
    strikes: 0,
    outs: 0,
    awayScore: 3,
    homeScore: 2,
    awayTeam: "키움",
    homeTeam: "LG",
    awayTeamFull: "키움",
    homeTeamFull: "LG",
    runner1b: false,
    runner2b: false,
    runner3b: false,
    runner1bName: null,
    runner2bName: null,
    runner3bName: null,
    currentBatter: "김선수",
    currentPitcher: "홈투수",
    stadium: "잠실",
    startTime: "18:30",
    statusCode: 4,
    statusInfo: "8회초",
    inningHalfDisplay: "8초",
  } as import("../../src/lib/hooks/useLiveGame").LiveGameData;
  const currentBox = kboDownLive.body.boxScore as NonNullable<
    import("../../src/app/api/game-detail/route").GameDetailResponse["boxScore"]
  >;
  const prevBox = {
    ...currentBox,
    awayBatters: currentBox.awayBatters.map((b) =>
      b.name === "김선수" ? { ...b, hits: 0, h2b: 0, h3b: 0, hr: 0, rbi: 0 } : b
    ),
  };
  const boxEvents = generateEvents(
    GAME_ID,
    { live, boxScore: prevBox },
    live,
    currentBox,
  ).events.filter((event) => event.type === "at_bat_double" || event.type === "at_bat_hit");
  const relayEvents = generateRelayEvents(
    GAME_ID,
    [{
      inning: 8,
      half: "top",
      teamName: "키움",
      plays: [{ batterName: "김선수", result: "좌익선상 2루타", type: "hit" }],
    }],
    live,
  ).filter((event) => event.type === "at_bat_double" || event.type === "at_bat_hit");
  assert.deepEqual(boxEvents.map((event) => event.type), ["at_bat_double"]);
  assert.deepEqual(relayEvents.map((event) => event.type), ["at_bat_double"]);
  assert.equal(boxEvents[0].id, relayEvents[0].id, "record/relay double semantic id exact match");

  const naverDown = await scenario("KBO normal + Naver blackhole", "normal", "blackhole", "final");
  assert.equal(naverDown.body.status, "final");
  assert.equal(naverDown.body.linescore.away.R, 3);
  assert.ok(naverDown.body.boxScore.awayBatters.length > 0);
  assert.ok(naverDown.body.lineup?.away.length > 0);
  assert.equal(naverDown.body.lineup?.away[0].name, "김선수", "KBO 정상이면 KBO 라인업 유지(Naver 미침범)");
  assert.equal(naverDown.body.lineup?.awayStarter, undefined, "KBO 경로에선 starter 필드 미설정(기존 계약 무변경)");
  assert.equal(naverDown.degradationEvents.length, 0);

  const partial = await scenario("KBO partial schema + Naver normal", "partial", "normal", "final");
  assert.equal(partial.body.status, "final");
  assert.equal(partial.body.linescore.away.R, 3);
  assert.ok(partial.body.boxScore.awayBatters.length > 0);
  assert.equal(partial.body.lineup?.isToday, true, "KBO lineup 빈응답 → Naver preview 폴백");
  assert.ok(partial.body.meta.broadcastChannels?.length > 0, "degraded detail keeps settled KBO TV_IF");
  assert.deepEqual(partial.degradationEvents, [{ apiName: "kbo-game-detail", reason: "schema-error" }]);

  const pitchZero = await scenario("KBO pitchCount zero + Naver complete", "pitch-zero", "normal", "final");
  assert.equal(pitchZero.body.trace?.boxScoreSource, "naver");
  assert.ok(
    [...pitchZero.body.boxScore.awayPitchers, ...pitchZero.body.boxScore.homePitchers]
      .every((p: { pitchCount: number }) => p.pitchCount > 0),
    "KBO 200-partial pitchCount=0 is replaced by complete Naver bf values",
  );

  const pitchZeroDualPartial = await scenario(
    "KBO pitchCount zero + Naver partial",
    "pitch-zero",
    "partial",
    "final",
  );
  assert.equal(pitchZeroDualPartial.body.boxScore, null, "dual partial box fails closed");
  assert.equal(pitchZeroDualPartial.body.trace?.boxScoreSource, "none");

  for (const naverMode of ["bf-zero", "bf-missing", "bf-hidden-row"] as const) {
    const result = await scenario(
      `KBO pitchCount zero + Naver ${naverMode}`,
      "pitch-zero",
      naverMode,
      "final",
    );
    assert.equal(result.body.boxScore, null, `${naverMode}: positive innings without bf fails closed`);
    assert.equal(result.body.trace?.boxScoreSource, "none");
  }

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
  assert.equal(retry.body.lineup?.isToday, true, "srId 재시도 실패해도 Naver preview 폴백");
  assert.deepEqual(retry.degradationEvents, [{ apiName: "kbo-game-detail", reason: "timeout" }]);

  const httpError = await scenario("KBO HTTP 503 + Naver normal", "http-error", "normal", "final");
  assert.equal(httpError.body.status, "final");
  assert.deepEqual(
    httpError.degradationEvents,
    [{ apiName: "kbo-game-detail", reason: "http-error" }],
  );

  const noContent = await scenario("KBO HTTP 204 + Naver preview-only", "no-content", "preview-only", "final");
  assert.equal(noContent.body.lineup?.isToday, false);
  assert.equal(noContent.body.lineup?.away.length, 0);
  assert.equal(noContent.body.lineup?.home.length, 0);
  assert.equal(noContent.body.lineup?.awayStarter, "원정투수");
  assert.equal(noContent.body.lineup?.homeStarter, "홈투수");
  assert.equal(noContent.body.trace?.lineupSource, "naver-preview");

  const empty = await scenario("KBO HTTP 200 empty + Naver preview-only", "empty", "preview-only", "final");
  assert.equal(empty.body.trace?.lineupSource, "naver-preview");
  assert.equal(empty.body.lineup?.awayStarter, "원정투수");
  assert.equal(empty.body.lineup?.homeStarter, "홈투수");

  const previewPartial = await scenario(
    "KBO HTTP 200 empty + Naver preview partial",
    "empty",
    "preview-partial",
    "final",
  );
  assert.equal(previewPartial.body.lineup, null, "one-sided preview starter fails closed");
  assert.equal(previewPartial.body.trace?.lineupSource, "none");

  // request-context 관제 회귀 매트릭스:
  // scheduled/cancelled의 상세 자연 결측 및 목록 실패는 0건,
  // 동일 실패가 live/final이면 실제 열화이므로 원인 보존 1건.
  const degradationMatrix = [
    ["detail-schema-error", "schema-error"],
    ["detail-http-error", "http-error"],
    ["detail-timeout", "timeout"],
    ["list-http-error", "http-error"],
  ] as const;
  for (const [mode, reason] of degradationMatrix) {
    for (const state of ["scheduled", "cancelled", "live", "final"] as const) {
      const result = await scenario(`KBO ${mode} + Naver ${state}`, mode, "normal", state);
      assert.equal(result.body.status, state, `${mode}/${state}: canonical status 유지`);
      if (state === "scheduled" || state === "cancelled") {
        assert.equal(
          result.degradationEvents.length,
          0,
          `${mode}/${state}: 정상 자연 결측은 관제 0건`,
        );
      } else {
        assert.ok(result.body.boxScore?.awayBatters.length > 0, `${mode}/${state}: Naver fallback 유지`);
        assert.deepEqual(
          result.degradationEvents,
          [{ apiName: "kbo-game-detail", reason }],
          `${mode}/${state}: 실제 열화 원인 1건`,
        );
      }
    }
  }

  const scheduled = await scenario("normal scheduled", "normal", "normal", "scheduled");
  assert.equal(scheduled.body.status, "scheduled");
  assert.equal(scheduled.body.linescore, null);
  assert.equal(scheduled.body.boxScore, null);
  assert.equal(scheduled.body.lineup?.isToday, false);
  assert.equal(scheduled.body.lineup?.awayStarter, "원정투수");
  assert.equal(scheduled.body.lineup?.homeStarter, "홈투수");
  assert.equal(scheduled.body.trace?.lineupSource, "naver-preview");
  assert.equal(scheduled.body.lineup?.away.length, 0, "미확정 최근 타순은 노출하지 않음");
  assert.equal(scheduled.body.lineup?.home.length, 0, "미확정 최근 타순은 노출하지 않음");
  assert.equal(scheduled.degradationEvents.length, 0);
  assert.ok(scheduled.body.meta.broadcastChannels?.length > 0, "scheduled KBO TV_IF preserved");

  const cancelled = await scenario("normal cancelled", "normal", "normal", "cancelled");
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(cancelled.body.linescore, null);
  assert.equal(cancelled.body.boxScore, null);
  assert.equal(cancelled.degradationEvents.length, 0);
  assert.ok(cancelled.body.meta.broadcastChannels?.length > 0, "cancelled KBO TV_IF preserved");

  // mutation guard: 후속 fetchGames() 기본 10초 경로가 route에 재유입되면 즉시 red.
  const routeSource = readFileSync("src/app/api/game-detail/route.ts", "utf8");
  const naverRecordSource = readFileSync("src/lib/crawler/naver-record.ts", "utf8");
  assert.doesNotMatch(routeSource, /\bfetchGames\s*\(/, "route must not reintroduce fetchGames 10s await");
  assert.match(routeSource, /signal:\s*deadlineSignal/g, "shared absolute deadline wiring retained");
  assert.match(
    naverRecordSource,
    /rawPitchersComplete\(pb\.away\).*rawPitchersComplete\(pb\.home\)/,
    "Naver box completeness validates raw pitcher rows before name filtering",
  );

  console.log("game-detail bounded fallback: actual GET degradation matrix PASS");
}

main()
  .finally(() => {
    AbortSignal.timeout = nativeTimeout as typeof AbortSignal.timeout;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
