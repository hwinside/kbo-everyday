import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "smoke-service-role-key";

type Failure = string;

function cacheControlOf(headers?: HeadersInit): string | null {
  if (!headers) return null;
  return new Headers(headers).get("Cache-Control");
}

function expectEqual<T>(failures: Failure[], label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expect(condition: unknown, failures: Failure[], label: string): void {
  if (!condition) failures.push(label);
}

/**
 * route ↔ service 직접 대조(삼순 3차 NO-GO ②).
 *
 * thin route 의 GET 을 실제로 실행해 같은 fixture 에서 service 가 낸 결과와
 * body·status·Cache-Control 을 직접 비교한다. hard-code 기대값 비교만으로는
 * route 래퍼가 status/header 를 떨굜도 못 잡는다.
 *
 * 주의: 이 대조는 "route 가 service 를 그대로 흔리는가"만 증명한다. service 값 자체의
 * 회귀는 같은 harness 의 hard-code 계약 fixture(checkPlayerStats 등)가 잡는다 — 둘을
 * 함께 두어야 양방향 mutant 가 RED 가 된다.
 */
async function compareRouteToService(
  failures: Failure[],
  label: string,
  response: Response,
  service: { body: unknown; status?: number; headers?: HeadersInit },
): Promise<void> {
  expectEqual(failures, `[P] ${label} route↔service status`, response.status, service.status ?? 200);
  expectEqual(
    failures,
    `[P] ${label} route↔service Cache-Control`,
    response.headers.get("Cache-Control"),
    cacheControlOf(service.headers),
  );
  const routeBody = await response.json();
  expectEqual(
    failures,
    `[P] ${label} route↔service body`,
    JSON.stringify(routeBody),
    JSON.stringify(service.body),
  );
}

function hitterHtml(): string {
  const tbody = (cells: string[]) => `<tbody><tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr></tbody>`;
  return [
    "<table>",
    tbody(["LG", ".321", "88", "350", "300", "55", "96", "20", "3", "12", "158", "60", "8", "2", "4", "3"]),
    tbody(["40", "5", "2", "50", "0", ".527", ".400", "1", ".800", "0", ".927"]),
    "</table>",
  ].join("");
}

function makeGameLogBuilder(result: { data: unknown[] | null; error: { message: string } | null }) {
  let orderCalls = 0;
  const builder: {
    select: () => typeof builder;
    eq: () => typeof builder;
    order: (...args: unknown[]) => Promise<typeof result> | typeof builder;
  } = {
    select: () => builder,
    eq: () => builder,
    order: () => {
      orderCalls += 1;
      if (orderCalls < 2) return builder;
      return Promise.resolve(result);
    },
  };
  return builder;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function cells(values: unknown[]) {
  return values.map((Text) => ({ Text: String(Text) }));
}

function scoreboard(state: "live" | "scheduled" | "final") {
  if (state === "scheduled") {
    return [[{
      STADIUM_NM: "잠실",
      GAME_START_TM: "18:30",
      CANCEL_SC_NM: "",
      T_SCORE_CN: "0",
      B_SCORE_CN: "0",
    }]];
  }
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
        { row: cells(["", "키움", 0, 1, 0, 0, 0, 0, 2, 0, 0, 3, 7, 0, 2]) },
        { row: cells(["", "LG", 0, 0, 0, 2, 0, 0, 0, 0, state === "live" ? "-" : 0, 2, 6, 1, 3]) },
      ],
    })],
  ];
}

function lineup() {
  const side = (name: string) => [JSON.stringify({
    rows: [{ row: cells([1, "중견수", name, "1.2"]) }],
  })];
  return [[{ LINEUP_CK: true }], [], [], side("김선수"), side("홍길동")];
}

function boxScore() {
  return {
    tables: [
      { rows: [] },
      { rows: [{ row: cells([1, "중", "김선수", 4, 2, 1, 1, ".500"]) }] },
      { rows: [{ row: cells([1, "중", "홍길동", 4, 1, 1, 0, ".250"]) }] },
      { rows: [{ row: cells(["원정투수", "선발", "패", 0, 0, 0, "9", 31, 102, 30, 6, 0, 2, 8, 2, 2, "2.00"]) }] },
      { rows: [{ row: cells(["홈투수", "선발", "승", 0, 0, 0, "9", 31, 102, 30, 6, 0, 2, 8, 2, 2, "2.00"]) }] },
    ],
  };
}

function kboList(state: "live" | "scheduled" | "final" | "cancelled") {
  return {
    game: [{
      G_ID: "20260729WOLG0",
      G_DT: "20260729",
      G_TM: "18:30",
      S_NM: "잠실",
      AWAY_ID: "WO",
      HOME_ID: "LG",
      AWAY_NM: "키움",
      HOME_NM: "LG",
      T_SCORE_CN: "3",
      B_SCORE_CN: "2",
      GAME_INN_NO: state === "scheduled" || state === "cancelled" ? 0 : 9,
      GAME_TB_SC: "T",
      GAME_STATE_SC: state === "final" ? "3" : state === "live" ? "2" : "1",
      // cancelled: 양의 정수 코드 = 취소 사유(isKboGameCancelled SSOT 계약)
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

function naverSchedule(state: "live" | "scheduled" | "final") {
  return {
    code: 200,
    success: true,
    result: {
      games: [{
        gameId: "20260729WOLG02026",
        gameDateTime: "2026-07-29T18:30:00",
        stadium: "잠실",
        awayTeamCode: "WO",
        homeTeamCode: "LG",
        awayTeamName: "키움",
        homeTeamName: "LG",
        awayTeamScore: state === "scheduled" ? 0 : 3,
        homeTeamScore: state === "scheduled" ? 0 : 2,
        statusCode: state === "final" ? "RESULT" : state === "live" ? "STARTED" : "READY",
        statusInfo: state === "live" ? "9회초" : state === "final" ? "경기종료" : "경기전",
        cancel: false,
        broadChannel: "KBS N SPORTS",
      }],
    },
  };
}

function naverPreview(state: "live" | "scheduled" | "final") {
  const gameInfo = { gdate: "20260729", aCode: "WO", hCode: "LG" };
  if (state === "scheduled") {
    return {
      code: 200,
      success: true,
      result: {
        previewData: {
          gameInfo,
          awayTeamLineUp: { fullLineUp: [{ positionName: "선발투수", playerName: "원정투수" }] },
          homeTeamLineUp: { fullLineUp: [{ positionName: "선발투수", playerName: "홈투수" }] },
        },
      },
    };
  }
  const positions = ["중견수", "유격수", "지명타자", "1루수", "우익수", "좌익수", "3루수", "포수", "2루수"];
  const side = (prefix: string, starter: string) => ({
    fullLineUp: [
      { positionName: "선발투수", playerName: starter },
      ...positions.map((positionName, index) => ({ positionName, playerName: `${prefix}${index + 1}` })),
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

function naverRecord(state: "live" | "final") {
  return {
    result: {
      recordData: {
        battersBoxscore: {
          away: [{ batOrder: 1, pos: "중", name: "김선수", ab: 4, hit: 2, run: 1, rbi: 1, hr: 0, h2: null, h3: null, bb: 0, kk: 1, sb: 0, hra: ".500", inn4: "좌2" }],
          home: [{ batOrder: 1, pos: "중", name: "홍길동", ab: 4, hit: 1, run: 1, rbi: 0, hr: 0, h2: null, h3: null, bb: 0, kk: 1, sb: 0, hra: ".250", inn4: "중안" }],
        },
        pitchersBoxscore: {
          away: [{ name: "원정투수", inn: "9", wls: "패", hit: 6, r: 2, hr: 0, kk: 8, bb: 2, bbhp: 2, bf: 102, er: 2, pa: 31, ab: 30, era: "2.00" }],
          home: [{ name: "홈투수", inn: "9", wls: "승", hit: 6, r: 2, hr: 0, kk: 8, bb: 2, bbhp: 2, bf: 102, er: 2, pa: 31, ab: 30, era: "2.00" }],
        },
        scoreBoard: {
          inn: {
            away: [0, 1, 0, 0, 0, 0, 2, 0, 0],
            home: [0, 0, 0, 2, 0, 0, 0, 0, state === "live" ? "-" : 0],
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

type TodayFixtureState = "live" | "scheduled" | "final" | "cancelled" | "no-box";

function installTodayFetch(rawState: TodayFixtureState): typeof fetch {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    // no-box: 경기 목록은 live 로 주되, game-detail 내부 fetch(스코어보드·박스·naver)는
    // 전부 장애 → boxScore 결손 분기(HIDDEN + s-maxage=20)가 실제로 타진다.
    if (rawState === "no-box") {
      if (url.includes("GetKboGameList")) return json(kboList("live"));
      if (url.includes("api-gw.sports.naver.com/schedule/games")) return json(naverSchedule("live"));
      return new Response("upstream down (no-box fixture)", { status: 503 });
    }
    // cancelled: 목록 단계에서 상태가 확정되므로 상세 fetch 는 scheduled 픽스처로 충분하다.
    const state: "live" | "scheduled" | "final" = rawState === "cancelled" ? "scheduled" : rawState;
    if (url.includes("GetKboGameList")) return json(kboList(rawState === "cancelled" ? "cancelled" : state));
    if (url.includes("GetScoreBoard")) return json(scoreboard(state));
    if (url.includes("GetLineUpAnalysis")) return json(state === "scheduled" ? [] : lineup());
    if (url.includes("GetBoxScore")) return json(state === "scheduled" ? { tables: [] } : boxScore());
    if (url.includes("/record")) return json(naverRecord(state === "scheduled" ? "final" : state));
    if (url.includes("/preview")) return json(naverPreview(state));
    if (url.includes("/relay?")) return json({ result: { textRelayData: { inn: 1, textRelays: [] } } });
    if (url.includes("api-gw.sports.naver.com/schedule/games")) return json(naverSchedule(state));
    return original(input as RequestInfo | URL);
  }) as typeof fetch;
  return original;
}

async function checkPlayerStats(failures: Failure[]): Promise<void> {
  const { getPlayerStatsRouteResult } = await import("../../src/lib/services/player-stats");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(hitterHtml(), { status: 200 })) as typeof fetch;
    const ok = await getPlayerStatsRouteResult("12345", "타자");
    expectEqual(failures, "[P] player-stats success status", ok.status, undefined);
    expectEqual(failures, "[P] player-stats success cache", cacheControlOf(ok.headers), "public, s-maxage=60");
    expectEqual(
      failures,
      "[P] player-stats success body keys",
      JSON.stringify(Object.keys(ok.body as Record<string, unknown>).sort()),
      JSON.stringify(["cached", "stats"]),
    );
    expectEqual(failures, "[P] player-stats success stats.avg", (ok.body as { stats: { avg: string } }).stats.avg, ".321");

    const missing = await getPlayerStatsRouteResult(null, "타자");
    expectEqual(failures, "[P] player-stats missing-id status", missing.status, 400);
    expectEqual(failures, "[P] player-stats missing-id body.error", (missing.body as { error: string }).error, "id required");

    globalThis.fetch = (async () => new Response("upstream unavailable", { status: 503 })) as typeof fetch;
    const errored = await getPlayerStatsRouteResult("54321", "타자");
    expectEqual(failures, "[P] player-stats error status", errored.status, 500);
    expectEqual(failures, "[P] player-stats error cache", cacheControlOf(errored.headers), "no-store");
    expectEqual(failures, "[P] player-stats error body.shape", JSON.stringify(Object.keys(errored.body as Record<string, unknown>).sort()), JSON.stringify(["error", "stats"]));

    // route↔service 직접 대조 — thin route 의 GET 을 실제 실행해 같은 fixture 결과와 비교한다.
    const route = await import("../../src/app/api/player-stats/route");
    globalThis.fetch = (async () => new Response(hitterHtml(), { status: 200 })) as typeof fetch;
    await compareRouteToService(
      failures,
      "player-stats success",
      await route.GET(new NextRequest("https://keubo.fan/api/player-stats?id=12345&pos=%ED%83%80%EC%9E%90")),
      await getPlayerStatsRouteResult("12345", "타자"),
    );
    await compareRouteToService(
      failures,
      "player-stats missing-id",
      await route.GET(new NextRequest("https://keubo.fan/api/player-stats")),
      await getPlayerStatsRouteResult(null, "타자"),
    );
    globalThis.fetch = (async () => new Response("upstream unavailable", { status: 503 })) as typeof fetch;
    await compareRouteToService(
      failures,
      "player-stats error",
      await route.GET(new NextRequest("https://keubo.fan/api/player-stats?id=54321&pos=%ED%83%80%EC%9E%90")),
      await getPlayerStatsRouteResult("54321", "타자"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function checkPlayerGameLogs(failures: Failure[]): Promise<void> {
  const { getPlayerGameLogsRouteResult } = await import("../../src/lib/services/player-game-logs");
  const { supabaseAdmin } = await import("../../src/lib/supabase/admin");
  const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
  try {
    supabaseAdmin.from = (() => makeGameLogBuilder({
      data: [
        { game_id: "1", game_date: "2026-07-01", ab: 4, h: 2, hr: 0, rbi: 1, bb: 0, so: 0, ip_outs: 0, er: 0, h_allowed: 0, k: 0, bb_allowed: 0 },
        { game_id: "2", game_date: "2026-07-02", ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, so: 0, ip_outs: 0, er: 0, h_allowed: 0, k: 0, bb_allowed: 0 },
      ],
      error: null,
    })) as typeof supabaseAdmin.from;
    const ok = await getPlayerGameLogsRouteResult("12345", "타자");
    expectEqual(failures, "[P] player-game-logs success status", ok.status, undefined);
    expectEqual(failures, "[P] player-game-logs success cache", cacheControlOf(ok.headers), "s-maxage=60, stale-while-revalidate=120");
    expectEqual(failures, "[P] player-game-logs success count", (ok.body as { count: number }).count, 1);
    expect(Array.isArray((ok.body as { rows?: unknown[] }).rows), failures, "[P] player-game-logs success rows missing");

    const missing = await getPlayerGameLogsRouteResult(null, "타자");
    expectEqual(failures, "[P] player-game-logs missing-id status", missing.status, 400);
    expectEqual(failures, "[P] player-game-logs missing-id body.error", (missing.body as { error: string }).error, "id required");

    supabaseAdmin.from = (() => makeGameLogBuilder({
      data: null,
      error: { message: "db exploded" },
    })) as typeof supabaseAdmin.from;
    const errored = await getPlayerGameLogsRouteResult("12345", "타자");
    expectEqual(failures, "[P] player-game-logs error status", errored.status, 500);
    expectEqual(failures, "[P] player-game-logs error body.error", (errored.body as { error: string }).error, "db exploded");

    // route↔service 직접 대조
    const route = await import("../../src/app/api/player-game-logs/route");
    await compareRouteToService(
      failures,
      "player-game-logs error",
      await route.GET(new NextRequest("https://keubo.fan/api/player-game-logs?id=12345&pos=%ED%83%80%EC%9E%90")),
      await getPlayerGameLogsRouteResult("12345", "타자"),
    );
    await compareRouteToService(
      failures,
      "player-game-logs missing-id",
      await route.GET(new NextRequest("https://keubo.fan/api/player-game-logs")),
      await getPlayerGameLogsRouteResult(null, "타자"),
    );
    supabaseAdmin.from = (() => makeGameLogBuilder({
      data: [
        { game_id: "1", game_date: "2026-07-01", ab: 4, h: 2, hr: 0, rbi: 1, bb: 0, so: 0, ip_outs: 0, er: 0, h_allowed: 0, k: 0, bb_allowed: 0 },
      ],
      error: null,
    })) as typeof supabaseAdmin.from;
    await compareRouteToService(
      failures,
      "player-game-logs success",
      await route.GET(new NextRequest("https://keubo.fan/api/player-game-logs?id=12345&pos=%ED%83%80%EC%9E%90")),
      await getPlayerGameLogsRouteResult("12345", "타자"),
    );
  } finally {
    supabaseAdmin.from = originalFrom as typeof supabaseAdmin.from;
  }
}

async function checkStats(failures: Failure[]): Promise<void> {
  const { getStatsRouteResult } = await import("../../src/lib/services/stats");
  const ok = await getStatsRouteResult({ type: "batter", season: "2025" });
  expectEqual(failures, "[P] stats 2025 status", ok.status, undefined);
  expectEqual(failures, "[P] stats 2025 cache", cacheControlOf(ok.headers), "public, s-maxage=3600");
  expectEqual(failures, "[P] stats 2025 body keys", JSON.stringify(Object.keys(ok.body as Record<string, unknown>).sort()), JSON.stringify(["count", "season", "stats", "type"]));
  expect((ok.body as { stats: unknown[] }).stats.length > 0, failures, "[P] stats 2025 stats empty");

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const errored = await getStatsRouteResult({ type: "batter", season: "2027" });
    expectEqual(failures, "[P] stats current error status", errored.status, 500);
    expectEqual(failures, "[P] stats current error cache", cacheControlOf(errored.headers), "no-store");
    expectEqual(failures, "[P] stats current error body.shape", JSON.stringify(Object.keys(errored.body as Record<string, unknown>).sort()), JSON.stringify(["error", "stats"]));

    // route↔service 직접 대조 (error 분기 — fetch 스텀 유지 상태)
    const route = await import("../../src/app/api/stats/route");
    await compareRouteToService(
      failures,
      "stats current error",
      await route.GET(new NextRequest("https://keubo.fan/api/stats?type=batter&season=2027")),
      await getStatsRouteResult({ type: "batter", season: "2027" }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // route↔service 직접 대조 (정상 분기 — 스텀 복원 후)
  const route = await import("../../src/app/api/stats/route");
  await compareRouteToService(
    failures,
    "stats 2025 success",
    await route.GET(new NextRequest("https://keubo.fan/api/stats?type=batter&season=2025")),
    await getStatsRouteResult({ type: "batter", season: "2025" }),
  );
}

async function checkPlayerTodayGame(failures: Failure[]): Promise<void> {
  const { getPlayerTodayGameRouteResult } = await import("../../src/lib/services/player-today-game");
  const originalFetch = installTodayFetch("live");
  try {
    const deferred: Array<() => Promise<void>> = [];
    const live = await getPlayerTodayGameRouteResult({
      teamId: 1,
      name: "홍길동",
      pos: "타자",
      onDeferredEffect: (effect) => deferred.push(effect),
    });
    expectEqual(failures, "[P] player-today-game live status", live.status, undefined);
    expectEqual(failures, "[P] player-today-game live cache", cacheControlOf(live.headers), "s-maxage=20, stale-while-revalidate=40");
    expectEqual(failures, "[P] player-today-game live body.shape", JSON.stringify(Object.keys(live.body as Record<string, unknown>).sort()), JSON.stringify(["batter", "isLive", "opponentName", "show", "status", "type"]));
    expectEqual(failures, "[P] player-today-game live body.status", (live.body as { status: string }).status, "live");
    expectEqual(failures, "[P] player-today-game live batter.onBase", (live.body as { batter: { onBase: number } }).batter.onBase, 1);
    expectEqual(failures, "[P] player-today-game live deferred count", deferred.length, 0);

    // route↔service 직접 대조 (live)
    const route = await import("../../src/app/api/player-today-game/route");
    await compareRouteToService(
      failures,
      "player-today-game live",
      await route.GET(new NextRequest("https://keubo.fan/api/player-today-game?team=1&name=%ED%99%8D%EA%B8%B8%EB%8F%99&pos=%ED%83%80%EC%9E%90")),
      await getPlayerTodayGameRouteResult({ teamId: 1, name: "홍길동", pos: "타자" }),
    );

    // 분기 결속: row-missing (박스스코어에 없는 이름) — HIDDEN + s-maxage=20
    const rowMissing = await getPlayerTodayGameRouteResult({ teamId: 1, name: "없는선수", pos: "타자" });
    expectEqual(failures, "[P] player-today-game row-missing cache", cacheControlOf(rowMissing.headers), "s-maxage=20");
    expectEqual(failures, "[P] player-today-game row-missing show", (rowMissing.body as { show: boolean }).show, false);
    await compareRouteToService(
      failures,
      "player-today-game row-missing",
      await route.GET(new NextRequest("https://keubo.fan/api/player-today-game?team=1&name=%EC%97%86%EB%8A%94%EC%84%A0%EC%88%98&pos=%ED%83%80%EC%9E%90")),
      await getPlayerTodayGameRouteResult({ teamId: 1, name: "없는선수", pos: "타자" }),
    );

    // 분기 결속: no-game (해당 팀 경기 없음) — HIDDEN("none") + s-maxage=60
    const noGame = await getPlayerTodayGameRouteResult({ teamId: 8, name: "홍길동", pos: "타자" });
    expectEqual(failures, "[P] player-today-game no-game cache", cacheControlOf(noGame.headers), "s-maxage=60");
    expectEqual(failures, "[P] player-today-game no-game status", (noGame.body as { status: string }).status, "none");
    await compareRouteToService(
      failures,
      "player-today-game no-game",
      await route.GET(new NextRequest("https://keubo.fan/api/player-today-game?team=8&name=%ED%99%8D%EA%B8%B8%EB%8F%99&pos=%ED%83%80%EC%9E%90")),
      await getPlayerTodayGameRouteResult({ teamId: 8, name: "홍길동", pos: "타자" }),
    );

    // 분기 결속: bad-params (teamId/name 미지정) — no-store
    const badParams = await getPlayerTodayGameRouteResult({ teamId: 0, name: "", pos: "타자" });
    expectEqual(failures, "[P] player-today-game bad-params cache", cacheControlOf(badParams.headers), "no-store");
    await compareRouteToService(
      failures,
      "player-today-game bad-params",
      await route.GET(new NextRequest("https://keubo.fan/api/player-today-game")),
      await getPlayerTodayGameRouteResult({ teamId: NaN, name: "", pos: "" }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 분기 결속: catch (상류 전면 장애) — no-store + status 200 명시
  const originalFetchCatch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new Error("kbo down");
    }) as typeof fetch;
    const crashed = await getPlayerTodayGameRouteResult({ teamId: 1, name: "홍길동", pos: "타자" });
    expectEqual(failures, "[P] player-today-game catch status", crashed.status, 200);
    expectEqual(failures, "[P] player-today-game catch cache", cacheControlOf(crashed.headers), "no-store");
    expectEqual(failures, "[P] player-today-game catch body.status", (crashed.body as { status: string }).status, "none");
    const route = await import("../../src/app/api/player-today-game/route");
    await compareRouteToService(
      failures,
      "player-today-game catch",
      await route.GET(new NextRequest("https://keubo.fan/api/player-today-game?team=1&name=%ED%99%8D%EA%B8%B8%EB%8F%99&pos=%ED%83%80%EC%9E%90")),
      await getPlayerTodayGameRouteResult({ teamId: 1, name: "홍길동", pos: "타자" }),
    );
  } finally {
    globalThis.fetch = originalFetchCatch;
  }

  const originalFetch2 = installTodayFetch("scheduled");
  try {
    const scheduled = await getPlayerTodayGameRouteResult({ teamId: 1, name: "홍길동", pos: "타자" });
    expectEqual(failures, "[P] player-today-game scheduled status", scheduled.status, undefined);
    expectEqual(failures, "[P] player-today-game scheduled cache", cacheControlOf(scheduled.headers), "s-maxage=60");
    expectEqual(failures, "[P] player-today-game scheduled body.shape", JSON.stringify(Object.keys(scheduled.body as Record<string, unknown>).sort()), JSON.stringify(["isLive", "opponentName", "show", "status", "type"]));
    expectEqual(failures, "[P] player-today-game scheduled show", (scheduled.body as { show: boolean }).show, false);
    const route = await import("../../src/app/api/player-today-game/route");
    await compareRouteToService(
      failures,
      "player-today-game scheduled",
      await route.GET(new NextRequest("https://keubo.fan/api/player-today-game?team=1&name=%ED%99%8D%EA%B8%B8%EB%8F%99&pos=%ED%83%80%EC%9E%90")),
      await getPlayerTodayGameRouteResult({ teamId: 1, name: "홍길동", pos: "타자" }),
    );
  } finally {
    globalThis.fetch = originalFetch2;
  }

  // 분기 결속: cancelled — HIDDEN(cancelled) + s-maxage=60 (삼순 4차 ① 명시 요구)
  const originalFetch3 = installTodayFetch("cancelled");
  try {
    const cancelled = await getPlayerTodayGameRouteResult({ teamId: 1, name: "홍길동", pos: "타자" });
    expectEqual(failures, "[P] player-today-game cancelled cache", cacheControlOf(cancelled.headers), "s-maxage=60");
    expectEqual(failures, "[P] player-today-game cancelled body.status", (cancelled.body as { status: string }).status, "cancelled");
    expectEqual(failures, "[P] player-today-game cancelled show", (cancelled.body as { show: boolean }).show, false);
    const route = await import("../../src/app/api/player-today-game/route");
    await compareRouteToService(
      failures,
      "player-today-game cancelled",
      await route.GET(new NextRequest("https://keubo.fan/api/player-today-game?team=1&name=%ED%99%8D%EA%B8%B8%EB%8F%99&pos=%ED%83%80%EC%9E%90")),
      await getPlayerTodayGameRouteResult({ teamId: 1, name: "홍길동", pos: "타자" }),
    );
  } finally {
    globalThis.fetch = originalFetch3;
  }

  // 분기 결속: no-box — 목록은 live 인데 상세(박스스코어) 결손 → HIDDEN(live) + s-maxage=20 (삼순 4차 ①)
  const originalFetch4 = installTodayFetch("no-box");
  try {
    const noBox = await getPlayerTodayGameRouteResult({ teamId: 1, name: "홍길동", pos: "타자" });
    expectEqual(failures, "[P] player-today-game no-box cache", cacheControlOf(noBox.headers), "s-maxage=20");
    expectEqual(failures, "[P] player-today-game no-box body.status", (noBox.body as { status: string }).status, "live");
    expectEqual(failures, "[P] player-today-game no-box show", (noBox.body as { show: boolean }).show, false);
    const route = await import("../../src/app/api/player-today-game/route");
    await compareRouteToService(
      failures,
      "player-today-game no-box",
      await route.GET(new NextRequest("https://keubo.fan/api/player-today-game?team=1&name=%ED%99%8D%EA%B8%B8%EB%8F%99&pos=%ED%83%80%EC%9E%90")),
      await getPlayerTodayGameRouteResult({ teamId: 1, name: "홍길동", pos: "타자" }),
    );
  } finally {
    globalThis.fetch = originalFetch4;
  }
}

async function checkGameDetail(failures: Failure[]): Promise<void> {
  const route = await import("../../src/app/api/game-detail/route");
  const service = await import("../../src/lib/services/game-detail");
  const originalFetch = installTodayFetch("final");
  try {
    const response = await route.GET(new NextRequest("https://keubo.fan/api/game-detail?gameId=20260729WOLG0"));
    expectEqual(failures, "[P] game-detail route status", response.status, 200);
    expectEqual(failures, "[P] game-detail route cache", response.headers.get("Cache-Control"), "private, no-cache");
    const payload = await response.json();
    expectEqual(failures, "[P] game-detail route body.status", payload.status, "final");
    expectEqual(failures, "[P] game-detail route body.trace.boxScoreSource", payload.trace?.boxScoreSource, "kbo");

    const deferred: Array<() => Promise<void>> = [];
    const servicePayload = await service.getGameDetailRouteResult({
      gameId: "20260729WOLG0",
      onDeferredEffect: (effect) => deferred.push(effect),
    });
    expectEqual(failures, "[P] game-detail service deferred count", deferred.length, 0);

    // 삼순 4차 ①: 동일 fixture 에서 route GET 전체 body 를 service 결과와 **직접 대조**한다.
    // 유일한 시계 파생 필드(trace.sourceAtMs·fetchedAtMs)만 정규화하고 나머지 전 필드를 비교
    // (제외 사유 명시: 두 호출의 wall-clock 이 다를 뿐 계약 필드가 아니다).
    const normalizeClock = (p: unknown): unknown => {
      const clone = JSON.parse(JSON.stringify(p)) as { trace?: { sourceAtMs?: number; fetchedAtMs?: number } };
      if (clone.trace) {
        clone.trace.sourceAtMs = 0;
        clone.trace.fetchedAtMs = 0;
      }
      return clone;
    };
    expectEqual(
      failures,
      "[P] game-detail route↔service full body",
      JSON.stringify(normalizeClock(payload)),
      JSON.stringify(normalizeClock(servicePayload)),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  const failures: Failure[] = [];
  try {
    await checkPlayerStats(failures);
    await checkPlayerGameLogs(failures);
    await checkStats(failures);
    await checkPlayerTodayGame(failures);
    await checkGameDetail(failures);
  } catch (error) {
    failures.push(`[P] parity harness crashed: ${(error as Error).stack ?? (error as Error).message}`);
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log("self-fetch-internal parity PASS");
}

void main();
