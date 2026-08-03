/**
 * 직관 통계 S1b DB RPC(PGlite/PG17) + owner-auth GET route actual shape 회귀.
 * 실행: npm run qa:venue-stats-s1b-db-route
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import type { KboGame } from "@/lib/crawler/kbo-api";
import type {
  SeasonGameFetcher,
  SeasonGameFetchResult,
} from "@/lib/crawler/season-games-cache";
import {
  canonicalPayloadHash,
  type CanonicalRowInput,
} from "@/lib/game-logs/completeness";
import { METRIC_IDS } from "@/lib/venue-stats/types";

/** 시즌 득점 baseline까지 보존하는 final fixture. */
function makeFinalGame(gameId: string): KboGame {
  const ids: Record<string, number> = { LG: 1, OB: 2, KT: 3, SS: 8 };
  return {
    gameId,
    date: gameId.slice(0, 8),
    time: "18:30",
    status: "final",
    awayTeamId: ids[gameId.slice(8, 10)],
    homeTeamId: ids[gameId.slice(10, 12)],
    awayScore: 5,
    homeScore: 3,
  } as unknown as KboGame;
}

/** 새 fetcher 계약(SeasonGameFetchResult) 헬퍼 — 경기 있는 날짜. */
function gamesResult(games: KboGame[]): SeasonGameFetchResult {
  return { games, emptyVerified: false };
}
/** verified-empty(무경기 확정) off-day. */
const VERIFIED_EMPTY: SeasonGameFetchResult = { games: [], emptyVerified: true };

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://venue-stats-s1b-test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

function migration(name: string): string {
  return readFileSync(resolve("supabase/migrations", name), "utf8");
}

const GAME_ID = "20260614LGOB0";
/** 우주에는 있지만 ledger가 없는 정규 final 경기 — LEFT JOIN 강등(누락 금지) 회귀용. */
const NO_LEDGER_GAME_ID = "20260615KTSS0";
const UNIVERSE = [
  { gameId: GAME_ID, gameDate: "2026-06-14" },
  { gameId: NO_LEDGER_GAME_ID, gameDate: "2026-06-15" },
];
const rows: CanonicalRowInput[] = [
  {
    kbo_id: "90001", player_type: "batter", game_id: GAME_ID, game_date: "2026-06-14",
    team_id: 1, team_code: "LG", opponent_team_id: 2, is_home: true, result: "W",
    ab: 4, h: 2, hr: 1, rbi: 2, bb: 0, so: 1,
    ip_outs: 0, er: 0, h_allowed: 0, k: 0, bb_allowed: 0,
  },
  {
    kbo_id: "90002", player_type: "pitcher", game_id: GAME_ID, game_date: "2026-06-14",
    team_id: 1, team_code: "LG", opponent_team_id: 2, is_home: true, result: "W",
    ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, so: 0,
    ip_outs: 18, er: 2, h_allowed: 5, k: 7, bb_allowed: 1,
  },
];

async function rpcDbRegression() {
  const db = new PGlite();
  await db.exec(`
    do $$ begin
      if not exists (select from pg_roles where rolname='service_role') then create role service_role; end if;
      if not exists (select from pg_roles where rolname='anon') then create role anon; end if;
      if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
    end $$;
  `);
  await db.exec(migration("20260606_player_game_logs.sql"));
  await db.exec(migration("20260730_player_game_log_ingestions.sql"));
  await db.exec(migration("20260730_venue_stats_team_boost_rpc.sql"));

  // ── RED→GREEN: backfill 0 (ledger 빈 상태) — 우주 경기가 누락되지 않고 전부 complete=false ──
  const zero = await db.query<{ payload: {
    games: Array<{ gameId: string; complete: boolean }>;
    teams: unknown[];
  } }>("select venue_stats_season_team_aggregates(2026, $1) as payload", [JSON.stringify(UNIVERSE)]);
  assert.deepEqual(zero.rows[0].payload.games, [
    { gameId: GAME_ID, gameDate: "2026-06-14", complete: false },
    { gameId: NO_LEDGER_GAME_ID, gameDate: "2026-06-15", complete: false },
  ]);
  assert.deepEqual(zero.rows[0].payload.teams, []);
  console.log("  ✓ RPC backfill 0: 우주 전 경기 반환 + 전부 complete=false (누락/false-green 0)");

  for (const row of rows) {
    await db.query(
      `insert into player_game_logs
       (kbo_id,player_type,game_id,game_date,team_id,team_code,opponent_team_id,is_home,result,
        ab,h,hr,rbi,bb,so,ip_outs,er,h_allowed,k,bb_allowed)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        row.kbo_id, row.player_type, row.game_id, row.game_date, row.team_id, row.team_code,
        row.opponent_team_id, row.is_home, row.result, row.ab, row.h, row.hr, row.rbi, row.bb,
        row.so, row.ip_outs, row.er, row.h_allowed, row.k, row.bb_allowed,
      ],
    );
  }
  await db.query(
    `insert into player_game_log_ingestions
     (game_id,game_date,status,expected_row_count,expected_payload_hash,persisted_row_count,
      unresolved_count,source_fetched_at,verified_at)
     values ($1,$2,'complete',$3,$4,$3,0,now(),now())`,
    [GAME_ID, "2026-06-14", rows.length, canonicalPayloadHash(rows)],
  );

  // ── RED→GREEN: 부분 backfill — ledger 있는 경기만 complete, 나머지는 강등(누락 금지) ──
  const green = await db.query<{ payload: {
    games: Array<{ gameId: string; complete: boolean }>;
    teams: Array<{ teamId: number; completeGames: number; ab: number; h: number; outs: number }>;
  } }>("select venue_stats_season_team_aggregates(2026, $1) as payload", [JSON.stringify(UNIVERSE)]);
  const payload = green.rows[0].payload;
  assert.deepEqual(payload.games, [
    { gameId: GAME_ID, gameDate: "2026-06-14", complete: true },
    { gameId: NO_LEDGER_GAME_ID, gameDate: "2026-06-15", complete: false },
  ]);
  assert.deepEqual(payload.teams, [{
    teamId: 1, completeGames: 1, ab: 4, h: 2, hr: 1, outs: 18, er: 2, hAllowed: 5,
  }]);
  console.log("  ✓ RPC 부분 backfill: ledger 없는 우주 경기 complete=false 강등 + complete 경기만 팀 합계 산입");

  await db.query("update player_game_logs set h=0 where game_id=$1 and kbo_id='90001'", [GAME_ID]);
  const red = await db.query<{ payload: {
    games: Array<{ complete: boolean }>;
    teams: unknown[];
  } }>("select venue_stats_season_team_aggregates(2026, $1) as payload", [JSON.stringify(UNIVERSE)]);
  assert.equal(red.rows[0].payload.games[0].complete, false);
  assert.deepEqual(red.rows[0].payload.teams, []);
  console.log("  ✓ RPC RED: 단일 stat drift → complete=false, 시즌 분모 누출 0");

  await db.query("update player_game_logs set h=2 where game_id=$1 and kbo_id='90001'", [GAME_ID]);
  const restored = await db.query<{ payload: { games: Array<{ complete: boolean }> } }>(
    "select venue_stats_season_team_aggregates(2026, $1) as payload", [JSON.stringify(UNIVERSE)],
  );
  assert.equal(restored.rows[0].payload.games[0].complete, true);
  console.log("  ✓ RPC GREEN 원복: complete=true");

  await backfillContrastRegression(db);
  await db.close();
}

/**
 * 삼순 P0 gate 1/2/3 — 실제 supported-season 수집 helper(collectSeasonGameUniverse) + route
 * 집계 경로(fetchSeasonAggregates)를 경유해 fault를 주입한다. 우주 배열 직접 주입이
 * 아니라 실제 allSettled 수집 로직을 타므로 공통 누락(날짜 실패 삼킴·.slice partial·
 * 동수 ID 치환)을 독립 검출한다.
 */
async function seasonUniverseFailClosedRegression() {
  const routeMod = await import("../../src/app/api/me/venue-stats/route");
  const { fetchSeasonAggregates, __resetSeasonAggregatesCaches } = routeMod;
  const { collectSeasonGameUniverse } = await import("../../src/lib/crawler/season-games-cache");

  // 수집 완전 우주(2경기) — 각각 서로 다른 game-bearing 날짜. 나머지 날짜는 verified-empty(off-day).
  const GAME_A = "20260614LGOB0"; // LG(1)·OB(2)
  const GAME_B = "20260615KTSS0"; // KT(3)·SS(8)
  const DATE_A = "20260614";
  const DATE_B = "20260615";
  const universeGames: Record<string, KboGame[]> = {
    [DATE_A]: [makeFinalGame(GAME_A)],
    [DATE_B]: [makeFinalGame(GAME_B)],
  };
  // 새 계약: 경기 있는 날짜는 gamesResult, 빈 날짜는 verified-empty(off-day).
  const fullFetcher: SeasonGameFetcher = async (date) =>
    universeGames[date] ? gamesResult(universeGames[date]) : VERIFIED_EMPTY;

  // 실제 RPC 루프백 — 전달받은 우주를 games(complete=true)로, teams는 complete 경기 참가팀 exact로 반환.
  //  P0-2 exact 계약: complete 경기의 모든 참가팀(LG·OB·KT·SS = 1·2·3·8)을 누락 없이 담아야 GREEN.
  const validTeams = [1, 2, 3, 8].map((teamId) => ({
    teamId, completeGames: 1, ab: 10, h: 3, hr: 1, outs: 9, er: 2, hAllowed: 4,
  }));
  const faithfulRpc = async (args: {
    p_games: Array<{ gameId: string; gameDate: string }>;
  }) => ({
    data: {
      games: args.p_games.map((g) => ({ ...g, complete: true })),
      teams: validTeams,
    },
    error: null,
  });

  // ─ GREEN: 완전 우주 + exact-set 일치 RPC + teams exact → seasonGames 2건 ─
  __resetSeasonAggregatesCaches();
  const green = await fetchSeasonAggregates(2026, { fetcher: fullFetcher, rpc: faithfulRpc });
  assert.notEqual(green.seasonGames, null);
  assert.equal(green.seasonGames!.length, 2);
  assert.deepEqual(
    green.seasonGames!.map(({ awayTeamId, homeTeamId, awayScore, homeScore }) => ({ awayTeamId, homeTeamId, awayScore, homeScore })),
    [
      { awayTeamId: 1, homeTeamId: 2, awayScore: 5, homeScore: 3 },
      { awayTeamId: 3, homeTeamId: 8, awayScore: 5, homeScore: 3 },
    ],
    "공식 final 스코어가 B3 시즌 득점 baseline으로 보존돼야 함",
  );
  assert.notEqual(green.teamSeasonTotals, null);
  assert.equal(green.teamSeasonTotals!.size, 4);
  console.log("  ✓ route gate GREEN: 완전 우주(날짜 실패 0) + exact-set 일치 + teams exact → seasonGames 2건");

  // ─ B3 gate RED (삼순 2026-08-02 P0): final 우주 중 1경기만 스코어/팀ID가 결손되어도
  //   공식 시즌 득점 baseline은 전부 fail-close 되어야 한다. 예전엔 그 경기만 officialGames에서
  //   조용히 빠져 남은 1경기만 분모로 “시즌 평균 득점”이 계산되는 부분 우주 false-green이었다.
  const missingScoreFetcher: SeasonGameFetcher = async (date) => {
    if (!universeGames[date]) return VERIFIED_EMPTY;
    if (date === DATE_B) {
      const broken = { ...makeFinalGame(GAME_B), awayScore: null } as unknown as KboGame;
      return gamesResult([broken]);
    }
    return gamesResult(universeGames[date]);
  };
  __resetSeasonAggregatesCaches();
  const b3Red = await fetchSeasonAggregates(2026, { fetcher: missingScoreFetcher, rpc: faithfulRpc });
  // 우주 자체는 유지된다(E1 일정·complete 판정은 스코어와 무관) — 공식 스코어만 전면 fail-close.
  assert.notEqual(b3Red.seasonGames, null, "스코어 결손이 우주 자체를 지우면 안 된다");
  assert.equal(b3Red.seasonGames!.length, 2);
  for (const game of b3Red.seasonGames!) {
    assert.equal(game.awayScore, undefined, `부분 스코어 우주에서 ${game.gameId} 공식 득점이 남아 있으면 부분 분모 계산이 된다`);
    assert.equal(game.homeScore, undefined);
    assert.equal(game.awayTeamId, undefined);
    assert.equal(game.homeTeamId, undefined);
  }
  console.log("  ✓ route B3 gate RED: final 1경기 스코어 결손 → 공식 시즌 득점 baseline 전면 fail-close(부분 우주 금지)");

  // ─ cache recovery RED (삼순 2026-08-02 P0): 스코어 결손 결과는 캐시하면 안 된다 ─
  //   결손 결과가 complete cache 에 들어가면 원천 소스가 복구돼도 TTL(10~60분) 동안
  //   `추가 fetch 0 · 공식 score 계속 null` 로 고착된다. 실제로 그렇게 관측됐다.
  let fetchCalls = 0;
  const countingMissingScore: SeasonGameFetcher = async (date) => {
    fetchCalls += 1;
    if (!universeGames[date]) return VERIFIED_EMPTY;
    if (date === DATE_B) {
      const broken = { ...makeFinalGame(GAME_B), awayScore: null } as unknown as KboGame;
      return gamesResult([broken]);
    }
    return gamesResult(universeGames[date]);
  };
  __resetSeasonAggregatesCaches();
  const degraded = await fetchSeasonAggregates(2026, { fetcher: countingMissingScore, rpc: faithfulRpc });
  assert.equal(degraded.seasonGames!.every((g) => g.awayScore === undefined), true);
  const fetchesAfterDegraded = fetchCalls;
  assert.ok(fetchesAfterDegraded > 0, "1차 수집은 실제 fetch 를 발생시켜야 함");

  // 소스 정상화 — 캐시가 없어야 재수집이 일어나고 공식 스코어가 복구된다.
  let recoveredFetchCalls = 0;
  const countingHealthy: SeasonGameFetcher = async (date) => {
    recoveredFetchCalls += 1;
    return universeGames[date] ? gamesResult(universeGames[date]) : VERIFIED_EMPTY;
  };
  const recovered = await fetchSeasonAggregates(2026, { fetcher: countingHealthy, rpc: faithfulRpc });
  assert.ok(
    recoveredFetchCalls > 0,
    `결손 결과가 캐시되어 재수집이 0회였음(TTL 고착): ${recoveredFetchCalls}`,
  );
  assert.deepEqual(
    recovered.seasonGames!.map((g) => g.awayScore),
    [5, 5],
    "소스 정상화 직후 재호출에서 공식 스코어가 복구돼야 함",
  );
  console.log("  ✓ route cache recovery RED: 스코어 결손 결과 no-store → 소스 정상화 재호출이 재수집·복구");

  // 반대로 완전한 결과는 캐시되어 추가 수집이 0회여야 한다(캐시 자체는 살아 있음).
  let afterCompleteFetches = 0;
  await fetchSeasonAggregates(2026, {
    fetcher: async (date) => {
      afterCompleteFetches += 1;
      return universeGames[date] ? gamesResult(universeGames[date]) : VERIFIED_EMPTY;
    },
    rpc: faithfulRpc,
  });
  assert.equal(afterCompleteFetches, 0, "완전 결과는 캐시되어 재수집 0회여야 함");
  console.log("  ✓ route cache: 완전 결과는 정상 캐시(추가 fetch 0)");

  // ─ gate1 RED (일자 1건 reject — off-day transient): 다른 날짜는 성공해도 전체 fail-closed ─
  const rejectOffDay: SeasonGameFetcher = async (date) => {
    if (date === "20260401") throw new Error("transient fetch fail");
    return universeGames[date] ? gamesResult(universeGames[date]) : VERIFIED_EMPTY;
  };
  __resetSeasonAggregatesCaches();
  const red1 = await fetchSeasonAggregates(2026, { fetcher: rejectOffDay, rpc: faithfulRpc });
  assert.equal(red1.seasonGames, null);
  assert.equal(red1.teamSeasonTotals, null);
  console.log("  ✓ route gate1 RED: 일자 1건 reject → complete=false → seasonGames null (상태 fail-closed)");

  // ─ gate1 RED (non-empty partial — game-bearing 날짜 reject): 다른 경기는 수집되어 non-empty지만 null ─
  const rejectGameDate: SeasonGameFetcher = async (date) => {
    if (date === DATE_B) throw new Error("transient fetch fail");
    return universeGames[date] ? gamesResult(universeGames[date]) : VERIFIED_EMPTY;
  };
  __resetSeasonAggregatesCaches();
  const red2 = await fetchSeasonAggregates(2026, { fetcher: rejectGameDate, rpc: faithfulRpc });
  assert.equal(red2.seasonGames, null);
  const partialCollection = await collectSeasonGameUniverse(2026, "0", { fetcher: rejectGameDate });
  assert.equal(partialCollection.complete, false);
  assert.ok(partialCollection.games.length > 0);
  assert.deepEqual(partialCollection.failedDates, [DATE_B]);
  console.log("  ✓ route gate1 RED: non-empty partial(게임날짜 reject) → games>0·complete=false → seasonGames null");

  // ─ gate2 RED (동수 ID 치환): 완전 우주(2건)이지만 RPC가 상이한 gameId 2건 반환 → exact-set 불일치 ─
  const substitutingRpc = async () => ({
    data: {
      games: [
        { gameId: GAME_A, gameDate: "2026-06-14", complete: true },
        { gameId: "20260615KTDIFFERENT", gameDate: "2026-06-15", complete: true },
      ],
      teams: validTeams,
    },
    error: null,
  });
  __resetSeasonAggregatesCaches();
  const red3 = await fetchSeasonAggregates(2026, { fetcher: fullFetcher, rpc: substitutingRpc });
  assert.equal(red3.seasonGames, null);
  console.log("  ✓ route gate2 RED: 동수 ID 치환(len 같음) → gameId+gameDate exact-set 불일치 → seasonGames null");

  // ─ GREEN 원복: 완전 우주 + 일치 RPC 다시 → non-null(fault 제거 시만 열림) ─
  __resetSeasonAggregatesCaches();
  const restored = await fetchSeasonAggregates(2026, { fetcher: fullFetcher, rpc: faithfulRpc });
  assert.notEqual(restored.seasonGames, null);
  console.log("  ✓ route gate GREEN 원복: fault 제거 → seasonGames 복구(완전 우주에서만 GREEN)");

  // ─ P0-2 teams exact + malformed reject ─
  await teamsExactRegression(routeMod, fullFetcher, GAME_A, GAME_B);
  // ─ 삼순 4차 P0-2 completeGames exact equality (undercount fail-closed) ─
  await completeGamesExactRegression(routeMod);
  // ─ 정규시즌 window 교집합 — 개막 전 날짜가 우주를 죽이지 않는다 ─
  await regularSeasonWindowScopeRegression();
  // ─ P0-1 verified-empty (actual global fetch 경유) ─
  await verifiedEmptyActualRegression();
  // ─ 삼순 4차 P0-1 series-aware verified-empty (3/12 유형 실소스 fixture) ─
  await seriesAwareVerifiedEmptyRegression();
  // ─ P0-3 complete-only 캐시 + single-flight (fetch 카운트 계측) ─
  await cacheAndSingleFlightRegression(routeMod, universeGames);
  // ─ 삼순 P1 (2026-08-02): time 결손 → isDayGame 미존재 (route actual) ─
  await dayGameParseRegression(routeMod, faithfulRpc, GAME_A, GAME_B, DATE_A, DATE_B);
}

/**
 * 삼순 P1 (2026-08-02) — `time` 결손을 낮경기로 오분류하지 않는지 **route actual** 로 고정.
 *
 * 이전 라운드에서 `parseDayGame()` 만 고치고 회귀에 결속하지 않아, 예전 결함
 * (`if (time === "") return true`)을 재주입해도 전 게이트가 PASS 했다(삼순 mutation 실증).
 * 여기서는 파서를 직접 부르지 않고 **fetchSeasonAggregates 결과의 seasonGames** 를 본다.
 */
async function dayGameParseRegression(
  routeMod: typeof import("../../src/app/api/me/venue-stats/route"),
  faithfulRpc: (args: { p_games: Array<{ gameId: string; gameDate: string }> }) => Promise<unknown>,
  gameA: string,
  gameB: string,
  dateA: string,
  dateB: string,
) {
  const { fetchSeasonAggregates, __resetSeasonAggregatesCaches } = routeMod;

  const withTime = (gameId: string, time: unknown): KboGame => ({
    ...makeFinalGame(gameId),
    time,
  } as unknown as KboGame);

  const fetcherOf = (aTime: unknown, bTime: unknown): SeasonGameFetcher =>
    async (date) => {
      if (date === dateA) return gamesResult([withTime(gameA, aTime)]);
      if (date === dateB) return gamesResult([withTime(gameB, bTime)]);
      return VERIFIED_EMPTY;
    };

  const runWith = async (aTime: unknown, bTime: unknown) => {
    __resetSeasonAggregatesCaches();
    const res = await fetchSeasonAggregates(2026, {
      fetcher: fetcherOf(aTime, bTime),
      rpc: faithfulRpc as never,
    });
    assert.notEqual(res.seasonGames, null, "우주 자체는 살아 있어야 함(시간만 결손)");
    const byId = new Map(res.seasonGames!.map((g) => [g.gameId, g]));
    return byId;
  };

  // ① 정상 시간 — 낮/야간이 실제로 분류된다(과잉 차단이 아님을 함께 증명).
  {
    const byId = await runWith("14:00", "18:30");
    assert.equal(byId.get(gameA)!.isDayGame, true, "14:00 은 낮경기");
    assert.equal(byId.get(gameB)!.isDayGame, false, "18:30 은 야간경기");
  }

  // ② 핵심 RED — 시간 결손/형식 이탈은 `isDayGame` 키 자체가 없어야 한다.
  //    구 결함(`Number("")===0` → 00시=낮)으로 되돌리면 여기서 FAIL 한다.
  for (const bad of ["", null, undefined, "  ", "24:00", "09:60", "abc", "1830", 0]) {
    const byId = await runWith(bad, "18:30");
    const game = byId.get(gameA)!;
    assert.ok(
      !("isDayGame" in game),
      `time=${JSON.stringify(bad)} 는 낮경기 판정 불가여야 함(actual: ${JSON.stringify(game.isDayGame)})`,
    );
    // 같은 응답의 정상 경기는 영향을 받지 않는다(결손 1건이 우주를 오염시키지 않음).
    assert.equal(byId.get(gameB)!.isDayGame, false);
  }

  // ③ 낮경기 "기회" 분모 — 시간 결손 경기는 seasonDayGames/seasonTotal 어느 쪽에도
  //    들어가지 않아야 한다. `isDayGame` 키 부재가 곧 분모 제외 계약이다.
  {
    const byId = await runWith("", "13:00");
    const known = [...byId.values()].filter((g) => "isDayGame" in g);
    assert.equal(known.length, 1, "시간 아는 경기만 기회 분모에 들어간다");
    assert.equal(known[0]!.isDayGame, true);
  }

  console.log("  ✓ route actual: time 결손/형식 이탈 → isDayGame 미존재(낮경기 기회 분모 제외), 정상 시간은 분류됨");
}

/**
 * 삼순 P0-2 — RPC teams 결과를 complete 경기 참가팀과 exact 대조하고 malformed를 fail-closed.
 * teams=[] / 누락 / 중복 / 우주 밖 / NaN·음수·누락 값(Number(v)||0 조용한 0 오염 제거)가 전부 null로 fail-closed.
 */
async function teamsExactRegression(
  routeMod: typeof import("../../src/app/api/me/venue-stats/route"),
  fullFetcher: SeasonGameFetcher,
  gameA: string,
  gameB: string,
) {
  const { fetchSeasonAggregates, __resetSeasonAggregatesCaches } = routeMod;
  const gamesOf = (rpcTeams: unknown[]) => async (args: {
    p_games: Array<{ gameId: string; gameDate: string }>;
  }) => ({
    data: { games: args.p_games.map((g) => ({ ...g, complete: true })), teams: rpcTeams },
    error: null,
  });
  const team = (over: Record<string, unknown>) => ({
    teamId: 1, completeGames: 1, ab: 10, h: 3, hr: 1, outs: 9, er: 2, hAllowed: 4, ...over,
  });
  // complete 우주 참가팀 = LG(1)·OB(2)·KT(3)·SS(8).
  const full = [1, 2, 3, 8].map((teamId) => team({ teamId }));

  const cases: Array<{ name: string; teams: unknown[]; expectNull: boolean }> = [
    { name: "teams=[] (complete 경기 존재 → 기대 팀 전원 누락)", teams: [], expectNull: true },
    { name: "partial (teamId 8 누락)", teams: [1, 2, 3].map((teamId) => team({ teamId })), expectNull: true },
    { name: "우주 밖 팀(teamId 99 extra)", teams: [...full, team({ teamId: 99 })], expectNull: true },
    { name: "중복 teamId(1 두 번)", teams: [...full, team({ teamId: 1 })], expectNull: true },
    { name: "malformed ab=NaN", teams: [team({ teamId: 1, ab: Number.NaN }), team({ teamId: 2 }), team({ teamId: 3 }), team({ teamId: 8 })], expectNull: true },
    { name: "malformed ab='abc'(문자열)", teams: [team({ teamId: 1, ab: "abc" }), team({ teamId: 2 }), team({ teamId: 3 }), team({ teamId: 8 })], expectNull: true },
    { name: "malformed h 누락(undefined)", teams: [team({ teamId: 1, h: undefined }), team({ teamId: 2 }), team({ teamId: 3 }), team({ teamId: 8 })], expectNull: true },
    { name: "malformed er=음수(-1)", teams: [team({ teamId: 1, er: -1 }), team({ teamId: 2 }), team({ teamId: 3 }), team({ teamId: 8 })], expectNull: true },
    { name: "completeGames=0(<1)", teams: [team({ teamId: 1, completeGames: 0 }), team({ teamId: 2 }), team({ teamId: 3 }), team({ teamId: 8 })], expectNull: true },
    { name: "completeGames=2(>우주 내 1경기)", teams: [team({ teamId: 1, completeGames: 2 }), team({ teamId: 2 }), team({ teamId: 3 }), team({ teamId: 8 })], expectNull: true },
    { name: "valid exact(1·2·3·8)", teams: full, expectNull: false },
  ];

  for (const c of cases) {
    __resetSeasonAggregatesCaches();
    const res = await fetchSeasonAggregates(2026, { fetcher: fullFetcher, rpc: gamesOf(c.teams) });
    if (c.expectNull) {
      assert.equal(res.seasonGames, null, `P0-2 RED 기대 null: ${c.name}`);
      assert.equal(res.teamSeasonTotals, null, `P0-2 RED teamSeasonTotals null: ${c.name}`);
    } else {
      assert.notEqual(res.seasonGames, null, `P0-2 GREEN: ${c.name}`);
      assert.equal(res.teamSeasonTotals!.size, 4, `P0-2 GREEN teams 4: ${c.name}`);
      // Number(v)||0 제거 확인 — valid 값이 그대로 보존(0 강등 없음).
      assert.equal(res.teamSeasonTotals!.get(1)!.ab, 10, "malformed 아닌 valid ab 보존");
    }
    void gameA; void gameB;
  }
  console.log("  ✓ P0-2 teams exact + malformed reject: teams=[]/누락/우주밖/중복/NaN/문자열/누락/음수/경계 = 전부 fail-closed, valid만 GREEN (Number(v)||0 제거)");
}

/**
 * backfill 대조군 우주 회귀 — 2026 정규 final 실데이터 dry-run(480 = 472 complete / 8 incomplete)과
 * 동형의 계약을 고정: 우주 480경기 중 472만 ledger complete여도 games는 항상 480개로 반환되고
 * 나머지 8경기는 complete=false로 강등된다(우주 누락 0).
 */
async function backfillContrastRegression(db: PGlite) {
  // 삼순 P0 gate 3 — 480 대조군 우주를 직접 배열 주입이 아니라 실제 수집
  // helper(collectSeasonGameUniverse) actual로 구성한다 — 공통 누락 경로를 우회하지 않기 위함.
  const gamesByDate: Record<string, KboGame[]> = {};
  const expected: Array<{ gameId: string; gameDate: string }> = [];
  for (let i = 0; i < 480; i++) {
    const day = new Date(Date.UTC(2026, 3, 1 + Math.floor(i / 5)));
    const date = day.toISOString().slice(0, 10);
    const ymd = date.replaceAll("-", "");
    const gameId = `${ymd}CT${String(i).padStart(3, "0")}`;
    (gamesByDate[ymd] ??= []).push(makeFinalGame(gameId));
    expected.push({ gameId, gameDate: date });
  }
  const { collectSeasonGameUniverse } = await import("../../src/lib/crawler/season-games-cache");
  const contrastFetcher: SeasonGameFetcher = async (date) =>
    gamesByDate[date] ? gamesResult(gamesByDate[date]) : VERIFIED_EMPTY;
  const collection = await collectSeasonGameUniverse(2026, "0", { fetcher: contrastFetcher });
  assert.equal(collection.complete, true);
  assert.equal(collection.failedDates.length, 0);
  // 수집 helper가 만든 final 우주를 그대로 RPC에 넘긴다 (route와 동일 매핑).
  const seen = new Set<string>();
  const universe: Array<{ gameId: string; gameDate: string }> = [];
  for (const g of collection.games) {
    if (g.status !== "final" || seen.has(g.gameId)) continue;
    seen.add(g.gameId);
    universe.push({ gameId: g.gameId, gameDate: `${g.date.slice(0, 4)}-${g.date.slice(4, 6)}-${g.date.slice(6, 8)}` });
  }
  assert.equal(universe.length, 480);
  // universe를 expected(생성 순서)와 exact-set 대조 — 수집 helper가 누락 없이 480 전부 전달함.
  const expectedKeys = new Set(expected.map((e) => `${e.gameId}\u0000${e.gameDate}`));
  assert.equal(universe.every((u) => expectedKeys.has(`${u.gameId}\u0000${u.gameDate}`)), true);
  for (let i = 0; i < 480; i++) {
    const { gameId, gameDate: date } = universe[i];
    if (i >= 472) continue; // 마지막 8경기는 ledger 미생성(incomplete 강등 대상)
    const teamId = (i % 10) + 1;
    const row: CanonicalRowInput = {
      kbo_id: `8${String(i).padStart(4, "0")}`, player_type: "batter", game_id: gameId,
      game_date: date, team_id: teamId, team_code: "CT", opponent_team_id: ((i + 1) % 10) + 1,
      is_home: true, result: "W", ab: 4, h: 1, hr: 0, rbi: 0, bb: 0, so: 0,
      ip_outs: 0, er: 0, h_allowed: 0, k: 0, bb_allowed: 0,
    };
    await db.query(
      `insert into player_game_logs
       (kbo_id,player_type,game_id,game_date,team_id,team_code,opponent_team_id,is_home,result,
        ab,h,hr,rbi,bb,so,ip_outs,er,h_allowed,k,bb_allowed)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        row.kbo_id, row.player_type, row.game_id, row.game_date, row.team_id, row.team_code,
        row.opponent_team_id, row.is_home, row.result, row.ab, row.h, row.hr, row.rbi, row.bb,
        row.so, row.ip_outs, row.er, row.h_allowed, row.k, row.bb_allowed,
      ],
    );
    await db.query(
      `insert into player_game_log_ingestions
       (game_id,game_date,status,expected_row_count,expected_payload_hash,persisted_row_count,
        unresolved_count,source_fetched_at,verified_at)
       values ($1,$2,'complete',1,$3,1,0,now(),now())`,
      [gameId, date, canonicalPayloadHash([row])],
    );
  }
  const result = await db.query<{ payload: {
    games: Array<{ complete: boolean }>;
    teams: Array<{ completeGames: number }>;
  } }>("select venue_stats_season_team_aggregates(2026, $1) as payload", [JSON.stringify(universe)]);
  const games = result.rows[0].payload.games;
  const complete = games.filter((g) => g.complete).length;
  assert.equal(games.length, 480);
  assert.equal(complete, 472);
  assert.equal(games.length - complete, 8);
  const teamSum = result.rows[0].payload.teams.reduce((s, t) => s + t.completeGames, 0);
  assert.equal(teamSum, 472);
  console.log("  ✓ RPC backfill 대조군(수집 helper actual 경유): 우주 480 = 472 complete / 8 incomplete (누락 0, 팀 합계 472)");
}

const jsonResponse = (obj: unknown) =>
  ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify(obj),
    json: async () => obj,
  }) as unknown as Response;

/** KBO GetKboGameList raw final 경기 — gameId(YYYYMMDD+AWAY+HOME+회차) slice로 팀코드 해석. */
const kboRawFinal = (gameId: string) => ({
  G_ID: gameId, G_DT: gameId.slice(0, 8), G_TM: "18:30", S_NM: "잠실",
  AWAY_ID: gameId.slice(8, 10), HOME_ID: gameId.slice(10, 12),
  AWAY_NM: gameId.slice(8, 10), HOME_NM: gameId.slice(10, 12),
  T_SCORE_CN: "5", B_SCORE_CN: "3", GAME_INN_NO: 9, GAME_TB_SC: "B",
  GAME_STATE_SC: "3", CANCEL_SC_ID: "0",
  T_PIT_P_NM: "", B_PIT_P_NM: "", W_PIT_P_NM: "", L_PIT_P_NM: "", SV_PIT_P_NM: "",
  STRIKE_CN: 0, BALL_CN: 0, OUT_CN: 0,
  B1_BAT_ORDER_NO: 0, B2_BAT_ORDER_NO: 0, B3_BAT_ORDER_NO: 0,
  B_P_NM: "", T_P_NM: "", T_RANK_NO: 1, B_RANK_NO: 2,
});

/** Naver schedule raw final 경기 — KBO 형식 gameId(13자)에서 날짜/팀코드 파생(재구성 일치). */
const naverRawFinal = (kboGameId: string) => {
  const ymd = kboGameId.slice(0, 8);
  const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  return {
    gameId: `${kboGameId}${ymd.slice(0, 4)}`,
    gameDateTime: `${iso}T18:30:00`, stadium: "수원",
    homeTeamCode: kboGameId.slice(10, 12), awayTeamCode: kboGameId.slice(8, 10),
    homeTeamName: kboGameId.slice(10, 12), awayTeamName: kboGameId.slice(8, 10),
    homeTeamScore: 4, awayTeamScore: 2, statusCode: "RESULT", statusInfo: "경기종료",
  };
};

/** KBO GetKboGameList / Naver schedule 를 global fetch 레벨에서 목킹(actual fetchGames 경유). */
function installKboNaverFetchMock(opts: {
  gameDate: string;
  gameId: string;
  faultDate: string;
  faultNaverHasGame: boolean;
}): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url =
      typeof input === "string" ? input : (input as { url?: string })?.url ?? String(input);
    if (url.includes("GetKboGameList")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { date?: string };
      if (body.date === opts.gameDate) {
        return jsonResponse({ game: [kboRawFinal(opts.gameId)] });
      }
      return jsonResponse({ game: [] }); // 그 외 전부 soft-empty(200 game:[])
    }
    if (url.includes("api-gw.sports.naver.com/schedule/games")) {
      const iso = url.match(/fromDate=(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
      const ymd = iso.replaceAll("-", "");
      if (ymd === opts.faultDate && opts.faultNaverHasGame) {
        return jsonResponse({ code: 200, success: true, result: { games: [naverRawFinal(`${ymd}KTSS0`)] } });
      }
      return jsonResponse({ code: 200, success: true, result: { games: [] } }); // verified-empty
    }
    throw new Error(`unexpected fetch url: ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * 정규시즌 window 교집합 회귀 — 진짜 사고 재현.
 *
 * 사고: 시즌 우주 수집이 3월 1일부터 훑는데 2026 개막은 3/28이다. 3/1~3/27은
 * 정규시즌 window 밖이라 srId="0" 조회가 "200-empty 미검증"으로 throw 하고,
 * 그 27일이 항상 failedDates 에 쌓여 complete 가 구조적으로 영원히 false 였다.
 * 결과: 직관 통계 팀 타율·ERA·홈런이 원장을 전부 채워도 `비교 데이터 준비 중`으로 막혔다.
 *
 * 개막 전은 start로 자르되, 유동적인 종료일 뒤는 조용히 자르지 않고 fail-close한다.
 */
async function regularSeasonWindowScopeRegression() {
  const { collectSeasonGameUniverse } = await import("../../src/lib/crawler/season-games-cache");
  const { REGULAR_SEASON_WINDOWS } = await import("../../src/lib/crawler/naver-games");
  const w = REGULAR_SEASON_WINDOWS["2026"];
  assert.ok(w, "2026 정규시즌 window 등록됨");

  // 수집 자체는 일어나지 않게 모든 날짜 verified-empty 로 닫고 범위만 관찰한다.
  const noop = async (): Promise<SeasonGameFetchResult> => VERIFIED_EMPTY;

  const regular = await collectSeasonGameUniverse(2026, "0", { today: "2026-08-01", fetcher: noop });
  const before = regular.expectedDates.filter((d) => d < w.start);
  assert.deepEqual(before, [], `개막(${w.start}) 전 날짜가 정규 우주에 남아있으면 영구 fail-close`);
  assert.ok(regular.expectedDates.includes(w.start), "개막일은 반드시 포함");
  assert.ok(regular.expectedDates.every((d) => d >= w.start), "전부 개막일 이후");
  assert.equal(regular.complete, true, "window 교집합이면 complete=true 도달 가능");

  const future = await collectSeasonGameUniverse(2026, "0", {
    today: "2026-10-01",
    fetcher: async (date) => date > w.end ? { games: [], emptyVerified: false } : VERIFIED_EMPTY,
  });
  assert.ok(future.expectedDates.includes("20261001"), "window.end 뒤 날짜를 조용히 제외하지 않음");
  assert.equal(future.complete, false, "순연 가능 날짜 미검증이면 complete=true 금지");
  assert.ok(future.failedDates.includes("20261001"));

  // 삼순 P0 RED — 앞의 assert 는 end 뒤 날짜를 **강제로** unverified 로 만들어 반대가설을
  // 검사하지 않았다. 진짜 경계는 "KBO+Naver 둘 다 미래 날짜를 빈 응답으로 줌" —
  // 그때 fetch 계층은 emptyVerified=true 를 보고하고, 수정 전엔 그걸 그대로 인정해
  // complete=true / last=20261031 로 권위 우주를 거짓 확정했다(독립 probe 재현).
  // end 뒤 horizon 은 응답 내용과 무관하게 구조적 incomplete 여야 한다.
  const alwaysVerifiedEmpty = await collectSeasonGameUniverse(2026, "0", {
    today: "2026-10-01",
    fetcher: async (): Promise<SeasonGameFetchResult> => VERIFIED_EMPTY,
  });
  assert.equal(
    alwaysVerifiedEmpty.complete,
    false,
    "end 뒤 미래 날짜가 양 소스 verified-empty 여도 우주 완전함을 확정하면 안 된다",
  );
  const beyondEnd = alwaysVerifiedEmpty.expectedDates.filter((d) => d > w.end);
  assert.ok(beyondEnd.length > 0, "10/1 horizon 이라 end 뒤 날짜가 존재해야 함(전제 확인)");
  assert.deepEqual(
    beyondEnd.filter((d) => !alwaysVerifiedEmpty.failedDates.includes(d)),
    [],
    "end 뒤 날짜는 전부 failedDates 에 있어야 함(구조적 미검증)",
  );
  assert.deepEqual(
    alwaysVerifiedEmpty.collectedDates.filter((d) => d > w.end),
    [],
    "end 뒤 날짜를 수집 성공으로 세지 않음",
  );
  // end 이내 구간은 종랰대로 verified-empty 가 성공이다(과잉 차단 아님).
  assert.ok(
    alwaysVerifiedEmpty.collectedDates.includes(w.end),
    "종료일 당일은 verified-empty 로 수집 성공",
  );
  assert.deepEqual(
    alwaysVerifiedEmpty.failedDates.filter((d) => d <= w.end),
    [],
    "end 이내는 기존대로 성공 — 이 가드가 정상 구간까지 막지 않는다",
  );

  // provisional end는 과거가 되어도 실제 종료일이 아니다. 운영자가 공식 actual end와
  // finalized=true를 함께 넣은 뒤에만 그 날짜에서 자르고 complete를 열 수 있다.
  const finalizedWindow = { start: w.start, end: "20261020", finalized: true } as const;
  const settledPast = await collectSeasonGameUniverse(2026, "0", {
    today: "2026-11-01",
    fetcher: async (): Promise<SeasonGameFetchResult> => VERIFIED_EMPTY,
    regularSeasonWindow: finalizedWindow,
  });
  assert.equal(settledPast.complete, true, "공식 actual end 확정 뒤 complete=true 도달");
  assert.deepEqual(
    settledPast.failedDates,
    [],
    "finalized actual end 이내 verified-empty는 성공",
  );
  assert.equal(settledPast.expectedDates.at(-1), finalizedWindow.end, "확정 실제 종료일에서 정확히 clip");

  // end 뒤에 실제 순연 경기가 있어도 같다 — 경기 데이터는 버리지 않되, 실제 종료일을
  // 모르므로 우주 완전함은 주장하지 않는다(window 갱신이 유일한 해소 조건).
  const postponed = await collectSeasonGameUniverse(2026, "0", {
    today: "2026-10-15",
    fetcher: async (date): Promise<SeasonGameFetchResult> =>
      date === "20261020" ? gamesResult([makeFinalGame("20261020LGOB0")]) : VERIFIED_EMPTY,
  });
  assert.ok(postponed.expectedDates.includes("20261020"), "고정 14일 밖 순연일도 수집 우주에 포함");
  assert.equal(postponed.complete, false, "provisional end 뒤 순연 경기면 complete 확정 금지");
  assert.ok(
    postponed.games.some((g) => g.gameId === "20261020LGOB0"),
    "10/20 실제 순연 경기 데이터 자체는 버리지 않는다",
  );

  // 전-시리즌 우주(srId≠"0")는 이 경계 규칙의 대상이 아니다 — 종랰 동작 보존.
  const allFuture = await collectSeasonGameUniverse(2026, "0,1,3,4,5,7,9", {
    today: "2026-10-01",
    fetcher: async (): Promise<SeasonGameFetchResult> => VERIFIED_EMPTY,
  });
  assert.equal(allFuture.complete, true, "전-시리즌 우주는 end 경계 규칙 미적용(기존 동작)");

  const unknown = await collectSeasonGameUniverse(2027, "0", {
    today: "2027-03-01",
    fetcher: async () => ({ games: [], emptyVerified: false }),
  });
  assert.equal(unknown.complete, false, "window 미등록 연도는 fail-close");

  // 전-시리즈 우주(시범·포스트 포함)는 종래대로 3월 1일부터 — 범위를 즐이지 않는다.
  const all = await collectSeasonGameUniverse(2026, "0,1,3,4,5,7,9", { fetcher: noop });
  assert.ok(all.expectedDates.includes("20260301"), "전-시리즈 우주는 3/1 포함(기존 동작 보존)");
  assert.ok(
    all.expectedDates.length > regular.expectedDates.length,
    "정규 전용 범위가 전-시리즈보다 좁다",
  );
  console.log(
    "  ✓ window 경계: 개막 전 0 · fake 10/1 미검증 fail-close · 미등록연도 fail-close",
  );
}

/**
 * 삼순 P0-1 — verified-empty.
 *
 * GREEN 은 actual global fetch 경유(배열 직접 주입 아님): KBO 200 game:[] soft-empty 가
 * Naver 전-시리즈 교차확인에서 무경기 확정(verified-empty)될 때만 성공한다.
 *
 * RED 는 fetcher seam 으로 진짜 unverified soft-empty(`games:[] + emptyVerified:false`)를
 * 주입해 collectSeasonGameUniverse 자체 계약(unverified 날짜는 성공으로 세지 않고
 * failedDates 로 묶어 complete=false)을 고정한다.
 *
 * ⚠️ 예전 RED 는 "KBO 200-empty + Naver 에 경기 존재"를 unverified 로 기대했지만,
 * fetchGames 가 soft-empty 에서 Naver 로 failover 하게 된 뒤(#991)로는 그 상황이
 * "Naver 값으로 정상 수집"이라 complete=true 가 맞다. 그 assert 가 그동안 통과한 것은
 * 계약이 지켜져서가 아니라 시즌 우주에 개막 전 날짜(3/1~3/27)가 섞여 있어
 * 무관한 이유로 complete=false 였기 때문이다(false-green). 개막 전 날짜를 우주에서
 * 제외하자 즉시 드러나 수정했다.
 */
async function verifiedEmptyActualRegression() {
  const { collectSeasonGameUniverse } = await import("../../src/lib/crawler/season-games-cache");
  const { fetchSeasonAggregates, __resetSeasonAggregatesCaches } = await import(
    "../../src/app/api/me/venue-stats/route"
  );
  const GAME_DATE = "20260614";
  const GAME_ID = "20260614LGOB0"; // LG(1)·OB(2)
  const FAULT_DATE = "20260615";

  // RED — fault date 가 진짜 unverified soft-empty(교차확인 미확정) → 성공 날짜로 세지 않는다.
  {
    const seamFetcher = async (date: string): Promise<SeasonGameFetchResult> =>
      date === FAULT_DATE
        ? { games: [], emptyVerified: false } // unverified soft-empty
        : date === GAME_DATE
          ? gamesResult([makeFinalGame(GAME_ID)])
          : VERIFIED_EMPTY; // 무경기 확정
    const red = await collectSeasonGameUniverse(2026, "0", { fetcher: seamFetcher });
    assert.equal(red.complete, false, "P0-1 RED: unverified soft-empty → complete=false");
    assert.ok(red.failedDates.includes(FAULT_DATE), "fault 날짜가 failedDates에");
    assert.ok(red.games.some((g) => g.gameId === GAME_ID), "non-empty partial(진짜 경기 수집)");
    __resetSeasonAggregatesCaches();
    const redAgg = await fetchSeasonAggregates(2026, {
      fetcher: seamFetcher,
      rpc: async () => ({ data: null, error: null }),
    });
    assert.equal(redAgg.seasonGames, null, "P0-1 RED route: seasonGames null (fail-closed)");
  }
  console.log("  ✓ P0-1 RED(seam): unverified soft-empty 날짜 → failedDates·complete=false·seasonGames null");

  // RED — KBO regular soft-empty인데 Naver에만 경기가 있으면 series를 확정할 수 없다.
  let restore = installKboNaverFetchMock({
    gameDate: GAME_DATE, gameId: GAME_ID, faultDate: FAULT_DATE, faultNaverHasGame: true,
  });
  try {
    const failover = await collectSeasonGameUniverse(2026, "0"); // 기본 fetcher=fetchSeasonUniverseDate
    assert.equal(failover.complete, false, "미설명 Naver 경기 → fail-close");
    assert.ok(failover.failedDates.includes(FAULT_DATE));
    assert.ok(!failover.games.some((g) => g.gameId === `${FAULT_DATE}KTSS0`));
  } finally {
    restore();
  }
  console.log("  ✓ P0-1 RED(actual fetch): KBO regular empty + 미설명 Naver 경기 → fail-close");

  // GREEN — fault date: Naver도 빈 배열 → verified-empty(무경기 확정) → 성공. 진짜 경기 1건 우주.
  restore = installKboNaverFetchMock({
    gameDate: GAME_DATE, gameId: GAME_ID, faultDate: FAULT_DATE, faultNaverHasGame: false,
  });
  try {
    const green = await collectSeasonGameUniverse(2026, "0");
    assert.equal(green.complete, true, "P0-1 GREEN: 모든 빈 날짜 verified-empty → complete=true");
    assert.equal(green.failedDates.length, 0);
    assert.ok(green.games.some((g) => g.gameId === GAME_ID));
    __resetSeasonAggregatesCaches();
    const greenAgg = await fetchSeasonAggregates(2026, {
      rpc: async (args) => ({
        data: {
          games: args.p_games.map((g) => ({ ...g, complete: true })),
          teams: [1, 2].map((teamId) => ({
            teamId, completeGames: 1, ab: 10, h: 3, hr: 1, outs: 9, er: 2, hAllowed: 4,
          })),
        },
        error: null,
      }),
    });
    assert.notEqual(greenAgg.seasonGames, null, "P0-1 GREEN route: seasonGames non-null");
    assert.equal(greenAgg.seasonGames!.length, 1);
  } finally {
    restore();
  }
  console.log("  ✓ P0-1 GREEN(actual fetch): verified-empty(무경기 확정)만 성공 → complete=true·seasonGames 1건");
}

/**
 * 삼순 4차 P0-1 series-aware mock — KBO GetKboGameList를 body.srId별로 분기(정규 "0" /
 * 비정규 "1,3,4,5,7,9")하고 Naver 전-시리즈는 series 미구분으로 시범경기를 그대로 반환한다
 * (2026-03-12 실소스 형태 재현).
 */
function installSeriesAwareFetchMock(opts: {
  regularDate: string;
  regularGameId: string;
  preseasonDate: string;
  preseasonGameIds: string[];
  /** RED용: KBO 비정규 시리즈 조회가 이 gameId들을 누락(→ Naver 경기 미설명). */
  kboNonRegularDrops?: string[];
}): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url =
      typeof input === "string" ? input : (input as { url?: string })?.url ?? String(input);
    if (url.includes("GetKboGameList")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { date?: string; srId?: string };
      if (body.srId === "0") {
        // 정규시즌 — regularDate에만 경기, 시범경기일 포함 나머지는 200 game:[](실소스 동일).
        if (body.date === opts.regularDate) {
          return jsonResponse({ game: [kboRawFinal(opts.regularGameId)] });
        }
        return jsonResponse({ game: [] });
      }
      if (body.srId === "1,3,4,5,7,9") {
        // 비정규 시리즈(시범/포스트/올스타) — preseasonDate에 시범경기.
        if (body.date === opts.preseasonDate) {
          const drops = new Set(opts.kboNonRegularDrops ?? []);
          return jsonResponse({
            game: opts.preseasonGameIds.filter((id) => !drops.has(id)).map(kboRawFinal),
          });
        }
        return jsonResponse({ game: [] });
      }
      return jsonResponse({ game: [] });
    }
    if (url.includes("api-gw.sports.naver.com/schedule/games")) {
      const iso = url.match(/fromDate=(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
      const ymd = iso.replaceAll("-", "");
      if (ymd === opts.preseasonDate) {
        // Naver는 series 미구분 — 시범경기도 정규와 동일 category로 반환(실측 2026-07-29).
        return jsonResponse({
          code: 200, success: true,
          result: { games: opts.preseasonGameIds.map(naverRawFinal) },
        });
      }
      return jsonResponse({ code: 200, success: true, result: { games: [] } });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * 삼순 4차 P0-1 — series-aware verified-empty. actual global fetch 경유:
 * 2026-07-11 실소스 유형(KBO 정규 srId=0 → []·Naver 올스타 WEEA0)이 있어도
 * 시즌 우주가 null로 죽지 않고 정규 무경기 확정(verified-empty)으로 처리되며(GREEN),
 * 시범/올스타는 우주·분모에 샐지 않는다. KBO 비정규 조회로 설명 안 되는 Naver 경기가
 * 남는 진짜 실패(정규 soft-drop 가능성)는 여전히 fail-closed(RED).
 */
async function seriesAwareVerifiedEmptyRegression() {
  const { collectSeasonGameUniverse } = await import("../../src/lib/crawler/season-games-cache");
  const { fetchSeasonAggregates, __resetSeasonAggregatesCaches } = await import(
    "../../src/app/api/me/venue-stats/route"
  );
  const REGULAR_DATE = "20260614";
  const REGULAR_GAME_ID = "20260614LGOB0"; // LG(1)·OB(2)
  const PRESEASON_DATE = "20260711";
  const PRESEASON_IDS = ["20260711WEEA0"];

  // GREEN — window 내부 올스타가 KBO non-regular exact로 설명되면 정규 무경기로 확정한다.
  let restore = installSeriesAwareFetchMock({
    regularDate: REGULAR_DATE, regularGameId: REGULAR_GAME_ID,
    preseasonDate: PRESEASON_DATE, preseasonGameIds: PRESEASON_IDS,
  });
  try {
    const green = await collectSeasonGameUniverse(2026, "0"); // 기본 fetcher=fetchSeasonUniverseDate
    assert.equal(green.complete, true, "P0-1 series GREEN: 시범경기일이 정규 우주를 죽이지 않는다");
    assert.equal(green.failedDates.length, 0);
    // 우주에는 정규 경기만 — 시범경기가 우주·분모에 샐지 않는다.
    assert.deepEqual(green.games.map((g) => g.gameId), [REGULAR_GAME_ID]);
    __resetSeasonAggregatesCaches();
    let rpcGames: string[] | null = null;
    const greenAgg = await fetchSeasonAggregates(2026, {
      rpc: async (args) => {
        rpcGames = args.p_games.map((g) => g.gameId);
        return {
          data: {
            games: args.p_games.map((g) => ({ ...g, complete: true })),
            teams: [1, 2].map((teamId) => ({
              teamId, completeGames: 1, ab: 10, h: 3, hr: 1, outs: 9, er: 2, hAllowed: 4,
            })),
          },
          error: null,
        };
      },
    });
    assert.notEqual(greenAgg.seasonGames, null, "P0-1 series GREEN route: seasonGames non-null(RPC 호출됨)");
    assert.deepEqual(rpcGames, [REGULAR_GAME_ID], "RPC 우주 = 정규 경기만(시범 미포함)");
  } finally {
    restore();
  }
  console.log("  ✓ P0-1 series GREEN(actual fetch): 7/11 올스타 exact 제외·정규 우주 생존·RPC 호출");

  // RED — window 내부 Naver 경기가 KBO non-regular로 설명되지 않으면 fail-close.
  restore = installSeriesAwareFetchMock({
    regularDate: REGULAR_DATE, regularGameId: REGULAR_GAME_ID,
    preseasonDate: PRESEASON_DATE, preseasonGameIds: PRESEASON_IDS,
    kboNonRegularDrops: ["20260711WEEA0"],
  });
  try {
    const scoped = await collectSeasonGameUniverse(2026, "0");
    assert.ok(scoped.expectedDates.includes(PRESEASON_DATE), "올스타일은 window 내부 수집 대상");
    assert.equal(scoped.complete, false, "미설명 Naver 경기는 fail-close");
    assert.ok(scoped.failedDates.includes(PRESEASON_DATE));
    assert.deepEqual(
      scoped.games.map((g) => g.gameId),
      [REGULAR_GAME_ID],
      "설명 안 되는 올스타가 우주·분모에 새지 않는다",
    );
    __resetSeasonAggregatesCaches();
    let rpcGames: string[] | null = null;
    const agg = await fetchSeasonAggregates(2026, {
      rpc: async (args) => {
        rpcGames = args.p_games.map((g) => g.gameId);
        return {
          data: {
            games: args.p_games.map((g) => ({ ...g, complete: true })),
            teams: [1, 2].map((teamId) => ({
              teamId, completeGames: 1, ab: 10, h: 3, hr: 1, outs: 9, er: 2, hAllowed: 4,
            })),
          },
          error: null,
        };
      },
    });
    assert.equal(agg.seasonGames, null, "미설명 window 내부 경기는 route를 fail-close");
    assert.equal(rpcGames, null, "불완전 우주면 RPC 미호출");
  } finally {
    restore();
  }
  console.log("  ✓ P0-1 series RED: 7/11 미설명 Naver 경기 → failedDates·RPC 미호출");
}

/**
 * 삼순 4차 P0-2 — completeGames exact equality. 우주에서 LG(1)가 complete 2경기인데
 * RPC가 completeGames=1(undercount)을 반환하면 B4 per-game 분모가 오염되므로 fail-closed(RED),
 * exact(2)만 수용(GREEN)되고 B4 분모 feed(completeGames)가 우주 기대수로 산출됨을 고정.
 */
async function completeGamesExactRegression(
  routeMod: typeof import("../../src/app/api/me/venue-stats/route"),
) {
  const { fetchSeasonAggregates, __resetSeasonAggregatesCaches } = routeMod;
  // LG(1) complete 2경기 우주 — 6/14 LG-OB, 6/16 LG-KT. 기대 completeGames: LG=2·OB=1·KT=1.
  const GAME_1 = "20260614LGOB0";
  const GAME_2 = "20260616LGKT0";
  const universeGames: Record<string, KboGame[]> = {
    "20260614": [makeFinalGame(GAME_1)],
    "20260616": [makeFinalGame(GAME_2)],
  };
  const fetcher: SeasonGameFetcher = async (date) =>
    universeGames[date] ? gamesResult(universeGames[date]) : VERIFIED_EMPTY;
  const rpcWith = (lgCompleteGames: number) => async (args: {
    p_games: Array<{ gameId: string; gameDate: string }>;
  }) => ({
    data: {
      games: args.p_games.map((g) => ({ ...g, complete: true })),
      teams: [
        { teamId: 1, completeGames: lgCompleteGames, ab: 20, h: 6, hr: 2, outs: 18, er: 4, hAllowed: 8 },
        { teamId: 2, completeGames: 1, ab: 10, h: 3, hr: 1, outs: 9, er: 2, hAllowed: 4 },
        { teamId: 3, completeGames: 1, ab: 10, h: 3, hr: 1, outs: 9, er: 2, hAllowed: 4 },
      ],
    },
    error: null,
  });

  // RED — undercount(실제 2 ≠ RPC 1) → fail-closed(null). 종전에는 상한만 검사해 통과했던 케이스.
  __resetSeasonAggregatesCaches();
  const red = await fetchSeasonAggregates(2026, { fetcher, rpc: rpcWith(1) });
  assert.equal(red.seasonGames, null, "P0-2 exact RED: completeGames undercount(2→1) → null");
  assert.equal(red.teamSeasonTotals, null, "P0-2 exact RED: teamSeasonTotals null");

  // GREEN — exact(2) 원복 → 수용, B4 분모 feed = 우주 기대 complete 수(2).
  __resetSeasonAggregatesCaches();
  const green = await fetchSeasonAggregates(2026, { fetcher, rpc: rpcWith(2) });
  assert.notEqual(green.seasonGames, null, "P0-2 exact GREEN: exact 일치만 수용");
  assert.equal(green.teamSeasonTotals!.get(1)!.completeGames, 2, "B4 per-game 분모 = 우주 기대수(2)");
  assert.equal(green.teamSeasonTotals!.get(2)!.completeGames, 1);
  console.log("  ✓ P0-2 completeGames exact equality: undercount 2→1 fail-closed(RED) → exact 2만 GREEN(B4 분모=기대수)");
}

/**
 * 삼순 P0-3 — complete-only 캐시 + single-flight. 주입 counting fetcher로 실제 수집 호출 계측.
 * (a) 반복 호출 2회차 캐시 히트 +0, (b) 동시 2호출=수집 1회, (c) 불완전 우주 미캐시→재수집,
 * (d) TTL 만료 후 refresh 재수집.
 */
async function cacheAndSingleFlightRegression(
  routeMod: typeof import("../../src/app/api/me/venue-stats/route"),
  universeGames: Record<string, KboGame[]>,
) {
  const {
    fetchSeasonAggregates,
    __resetSeasonAggregatesCaches,
    __expireSeasonAggregatesCache,
  } = routeMod;
  const validTeams = [1, 2, 3, 8].map((teamId) => ({
    teamId, completeGames: 1, ab: 10, h: 3, hr: 1, outs: 9, er: 2, hAllowed: 4,
  }));
  const faithfulRpc = async (args: { p_games: Array<{ gameId: string; gameDate: string }> }) => ({
    data: { games: args.p_games.map((g) => ({ ...g, complete: true })), teams: validTeams },
    error: null,
  });
  let calls = 0;
  const makeCounting = (): SeasonGameFetcher => async (date) => {
    calls++;
    return universeGames[date] ? gamesResult(universeGames[date]) : VERIFIED_EMPTY;
  };

  // (a) 반복 호출 — 2회차 캐시 히트 +0.
  __resetSeasonAggregatesCaches();
  calls = 0;
  const first = await fetchSeasonAggregates(2026, { fetcher: makeCounting(), rpc: faithfulRpc });
  const firstCalls = calls;
  assert.notEqual(first.seasonGames, null);
  assert.ok(firstCalls >= 150, `firstCalls≥150(시즌 전일자 수집): ${firstCalls}`);
  const second = await fetchSeasonAggregates(2026, { fetcher: makeCounting(), rpc: faithfulRpc });
  const secondAdditional = calls - firstCalls;
  assert.equal(secondAdditional, 0, `2회차 캐시 히트 +0: ${secondAdditional}`);
  assert.notEqual(second.seasonGames, null);
  console.log(`  ✓ P0-3 (a) complete 캐시: 1회차 ${firstCalls} fetch → 2회차 +${secondAdditional} (반복 폭주 차단)`);

  // (b) single-flight — 동시 2호출 = 수집 1회.
  __resetSeasonAggregatesCaches();
  calls = 0;
  const counting = makeCounting();
  const [c1, c2] = await Promise.all([
    fetchSeasonAggregates(2026, { fetcher: counting, rpc: faithfulRpc }),
    fetchSeasonAggregates(2026, { fetcher: counting, rpc: faithfulRpc }),
  ]);
  assert.notEqual(c1.seasonGames, null);
  assert.equal(c1, c2, "single-flight: 동일 결과 합류");
  assert.equal(calls, firstCalls, `동시 2호출=수집 1회(${firstCalls}): ${calls}`);
  console.log(`  ✓ P0-3 (b) single-flight: 동시 2호출 → 수집 ${calls}(=1회), 중복 생성 0`);

  // (c) partial(불완전 우주) 미캐시 — 다음 호출 재수집.
  __resetSeasonAggregatesCaches();
  calls = 0;
  const rejectFetcher: SeasonGameFetcher = async (date) => {
    calls++;
    if (date === "20260401") throw new Error("transient");
    return universeGames[date] ? gamesResult(universeGames[date]) : VERIFIED_EMPTY;
  };
  const p1 = await fetchSeasonAggregates(2026, { fetcher: rejectFetcher, rpc: faithfulRpc });
  assert.equal(p1.seasonGames, null, "partial → failClosed");
  const afterFirst = calls;
  const p2 = await fetchSeasonAggregates(2026, { fetcher: rejectFetcher, rpc: faithfulRpc });
  assert.equal(p2.seasonGames, null);
  assert.ok(calls > afterFirst, `partial 미캐시 → 재수집(${afterFirst}→${calls})`);
  console.log(`  ✓ P0-3 (c) partial 미캐시: 불완전 우주는 캐시 안 됨 → 재호출 재수집(${afterFirst}→${calls})`);

  // (d) TTL 만료 → refresh 재수집.
  __resetSeasonAggregatesCaches();
  calls = 0;
  await fetchSeasonAggregates(2026, { fetcher: makeCounting(), rpc: faithfulRpc });
  const beforeExpire = calls;
  __expireSeasonAggregatesCache(2026);
  await fetchSeasonAggregates(2026, { fetcher: makeCounting(), rpc: faithfulRpc });
  assert.ok(calls > beforeExpire, `TTL 만료 → refresh 재수집(${beforeExpire}→${calls})`);
  console.log(`  ✓ P0-3 (d) TTL 만료 refresh: 캐시 expire 후 재수집(${beforeExpire}→${calls})`);
  __resetSeasonAggregatesCaches();
}

function queryResult(data: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "is", "gte", "lt", "order", "limit", "range", "maybeSingle"]) {
    builder[method] = () => builder;
  }
  builder.then = (
    resolveResult: (value: { data: unknown; error: null }) => unknown,
  ) => Promise.resolve(resolveResult({ data, error: null }));
  return builder;
}

async function routeShapeRegression() {
  const adminModule = await import("../../src/lib/supabase/admin");
  const client = adminModule.supabaseAdmin as unknown as {
    auth: { getUser: (token: string) => Promise<unknown> };
    from: (table: string) => unknown;
  };
  const originalGetUser = client.auth.getUser;
  const originalFrom = client.from;
  client.auth.getUser = async (token) => ({
    data: { user: token === "owner-token" ? { id: "owner-user" } : null },
    error: token === "owner-token" ? null : { message: "invalid" },
  });
  client.from = (table) => {
    if (table === "venue_attendance") return queryResult([]);
    if (table === "profiles") return queryResult({ favorite_players: [], team_id: 1 });
    throw new Error(`unexpected table: ${table}`);
  };

  try {
    const { GET } = await import("../../src/app/api/me/venue-stats/route");
    const unauthorized = await GET(
      new NextRequest("http://localhost/api/me/venue-stats?season=2025"),
    );
    assert.equal(unauthorized.status, 401);

    const response = await GET(new NextRequest(
      "http://localhost/api/me/venue-stats?season=2025",
      { headers: { Authorization: "Bearer owner-token" } },
    ));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = await response.json();
    assert.equal(body.season, 2025);
    assert.equal(body.seasonSupport.status, "attendance_only");
    assert.equal(body.overall.state, "empty");
    assert.equal(body.gps.state, "empty");
    assert.deepEqual(Object.keys(body.overall.metrics).sort(), [...METRIC_IDS].sort());
    assert.deepEqual(Object.keys(body.gps.metrics).sort(), [...METRIC_IDS].sort());
    assert.deepEqual(body.overall.metrics.A1.denominator, {
      attendanceFinalGames: 0, teamSeasonGames: 0,
    });
    assert.equal(body.overall.metrics.E3.value, null);
    console.log("  ✓ owner-auth GET actual: 200 + overall/gps 동일 22-ID empty shape");
    console.log("  ✓ unauthenticated GET actual: 401");
  } finally {
    client.auth.getUser = originalGetUser;
    client.from = originalFrom;
  }
}

/**
 * PR #1088 신고 경계 actual GET 회귀.
 *
 * aggregate 완성 입력을 직접 넣지 않고 DB 11행 → route의 srId=0/비정규 fetch 분기 →
 * aggregate payload까지 그대로 태운다. route에서 비정규 fetch 또는 nonRegularGames 전달을
 * 끊으면 시범경기가 game_unavailable로 바뀌어 이 테스트가 RED여야 한다.
 */
async function routeEligibleAttendanceRegression() {
  const adminModule = await import("../../src/lib/supabase/admin");
  const client = adminModule.supabaseAdmin as unknown as {
    auth: { getUser: (token: string) => Promise<unknown> };
    from: (table: string) => unknown;
  };
  const originalGetUser = client.auth.getUser;
  const originalFrom = client.from;
  const originalFetch = globalThis.fetch;

  const eligibleIds = Array.from(
    { length: 9 },
    (_, index) => `202506${String(index + 1).padStart(2, "0")}OBLG0`,
  );
  const favoriteAwayId = "20250626WONC0";
  const preseasonId = "20250315OBLG0";

  const rawFinal = (
    gameId: string,
    awayCode: string,
    homeCode: string,
    awayScore: number,
    homeScore: number,
  ) => ({
    G_ID: gameId,
    G_DT: gameId.slice(0, 8),
    G_TM: "18:30",
    S_NM: "잠실",
    AWAY_ID: awayCode,
    HOME_ID: homeCode,
    AWAY_NM: awayCode,
    HOME_NM: homeCode,
    T_SCORE_CN: String(awayScore),
    B_SCORE_CN: String(homeScore),
    GAME_INN_NO: 9,
    GAME_TB_SC: "B",
    GAME_STATE_SC: "3",
    CANCEL_SC_ID: "0",
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
  });
  const regularGames = [
    ...eligibleIds.map((gameId, index) =>
      rawFinal(gameId, "OB", "LG", index === 8 ? 2 : 1, index === 8 ? 2 : 3)),
    rawFinal(favoriteAwayId, "WO", "NC", 2, 1),
  ];
  const nonRegularGames = [rawFinal(preseasonId, "OB", "LG", 1, 4)];
  const attendanceRows = [
    ...eligibleIds.map((gameId, index) => ({
      id: index + 1,
      game_id: gameId,
      game_date: `${gameId.slice(0, 4)}-${gameId.slice(4, 6)}-${gameId.slice(6, 8)}`,
      favorite_team_id_snapshot: 1,
      stadium_name: "잠실",
      recorded_at: "2025-06-30T00:00:00Z",
      source: "diary_manual",
    })),
    {
      id: 10,
      game_id: favoriteAwayId,
      game_date: "2025-06-26",
      favorite_team_id_snapshot: 2,
      stadium_name: "고척",
      recorded_at: "2025-06-26T00:00:00Z",
      source: "diary_manual",
    },
    {
      id: 11,
      game_id: preseasonId,
      game_date: "2025-03-15",
      favorite_team_id_snapshot: 2,
      stadium_name: "잠실",
      recorded_at: "2025-03-15T00:00:00Z",
      source: "diary_manual",
    },
  ];
  const requestedSrIds: string[] = [];

  client.auth.getUser = async (token) => ({
    data: { user: token === "owner-token" ? { id: "owner-user" } : null },
    error: token === "owner-token" ? null : { message: "invalid" },
  });
  client.from = (table) => {
    if (table === "venue_attendance") return queryResult(attendanceRows);
    if (table === "profiles") return queryResult({ favorite_players: [], team_id: 2 });
    return queryResult([]);
  };
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("GetKboGameList")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { srId?: string };
      requestedSrIds.push(body.srId ?? "");
      const games = body.srId === "0"
        ? regularGames
        : body.srId === "1,3,4,5,7,9"
          ? nonRegularGames
          : [];
      return new Response(JSON.stringify({ game: games }), { status: 200 });
    }
    return new Response("{}", { status: 500 });
  }) as typeof fetch;

  try {
    const { GET } = await import("../../src/app/api/me/venue-stats/route");
    const response = await GET(new NextRequest(
      "http://localhost/api/me/venue-stats?season=2025",
      { headers: { Authorization: "Bearer owner-token" } },
    ));
    assert.equal(response.status, 200);
    const body = await response.json();
    const overall = body.overall;
    const attendance = overall.metrics.A1.value?.attendance;
    assert.ok(requestedSrIds.includes("0"), "actual GET이 정규시즌 srId=0을 조회해야 함");
    assert.ok(
      requestedSrIds.includes("1,3,4,5,7,9"),
      "actual GET이 비정규 srId를 별도 조회해야 함",
    );
    assert.equal(overall.coverage.attendanceGames, 11);
    assert.equal(overall.coverage.finalGames, 9);
    assert.deepEqual(overall.coverage.invalidSnapshot, []);
    assert.deepEqual(
      overall.coverage.excludedAttendance.map((entry: { reason: string }) => entry.reason).sort(),
      ["favorite_team_not_playing", "non_regular_season"],
    );
    assert.deepEqual(
      attendance,
      { w: 8, l: 0, d: 1, rate: 8 / 9 },
      "신고 계정 팀 통계는 유효 9경기만으로 8승 0패 1무·88.9%",
    );
    console.log("  ✓ route actual 신고 fixture: 총11/산출9/8승0패1무/88.9% + 제외사유 1/1");
  } finally {
    client.auth.getUser = originalGetUser;
    client.from = originalFrom;
    globalThis.fetch = originalFetch;
  }
}

/**
 * 삼순 P1 (2026-08-02) — raw 응답 → route(`fetchGameErrorsWithinDeadline`) → aggregate D7
 * → 사용자 payload 까지 **실제 배선**을 검증한다.
 *
 * ⚠️ 이 회귀가 없어서, route 의 `gameErrors` 전달을 빈 Map 으로 끊어도
 * `venue-game-errors 45/45`·`aggregate 118/0`·`error-tags 24/24`·browser 가 전부 PASS 했다.
 * 컴포넌트는 각각 검증됐지만 **실사용자에게 태그가 0개여도 전체가 green** 이었다.
 * 여기서는 global fetch 를 실제 KBO 응답 shape 로 스텁하고 route `GET` 을 그대로 태운다.
 */
async function routeGameErrorsWiringRegression() {
  const GAME_ID = "20250725LGHH0";
  const adminModule = await import("../../src/lib/supabase/admin");
  const client = adminModule.supabaseAdmin as unknown as {
    auth: { getUser: (token: string) => Promise<unknown> };
    from: (table: string) => unknown;
  };
  const originalGetUser = client.auth.getUser;
  const originalFrom = client.from;
  const originalFetch = globalThis.fetch;

  /** KBO 경기목록 raw — LG(원정) 15 : 한화(홈) 11 final. */
  const gameListPayload = {
    game: [{
      G_ID: GAME_ID, G_DT: "20250725", G_TM: "18:30", S_NM: "대전",
      AWAY_ID: "LG", HOME_ID: "HH", AWAY_NM: "LG", HOME_NM: "한화",
      T_SCORE_CN: "15", B_SCORE_CN: "11", GAME_INN_NO: 9, GAME_TB_SC: "B",
      GAME_STATE_SC: "3", CANCEL_SC_ID: "0",
      T_PIT_P_NM: "", B_PIT_P_NM: "", W_PIT_P_NM: "", L_PIT_P_NM: "", SV_PIT_P_NM: "",
      STRIKE_CN: 0, BALL_CN: 0, OUT_CN: 0,
      B1_BAT_ORDER_NO: 0, B2_BAT_ORDER_NO: 0, B3_BAT_ORDER_NO: 0,
      B_P_NM: "", T_P_NM: "", T_RANK_NO: 1, B_RANK_NO: 2,
    }],
  };
  /** KBO GetScoreBoard raw — tail 4칸 R/H/E/BB. 원정 LG 2실책 / 홈 한화 0. */
  const scoreBoardPayload = (
    awayE: string,
    homeE: string,
    identity: { gameId?: string; awayCode?: string; homeCode?: string } = {},
  ) => {
    const row = (r: string, e: string) => ({
      row: [
        { Text: "" }, { Text: "T" },
        { Text: "0" }, { Text: "1" }, { Text: "0" },
        { Text: r }, { Text: "14" }, { Text: e }, { Text: "3" },
      ],
    });
    return [
      [{
        G_ID: identity.gameId ?? GAME_ID,
        G_DT: "2025-07-25",
        AWAY_ID: identity.awayCode ?? "LG",
        HOME_ID: identity.homeCode ?? "HH",
        END_TM: "21:30",
        CANCEL_SC_NM: "",
      }],
      [JSON.stringify({ rows: [row("15", awayE), row("11", homeE)] })],
    ];
  };

  const install = (opts: {
    awayE: string;
    homeE: string;
    scoreGameId?: string;
    awayCode?: string;
    homeCode?: string;
  }) => {
    const calls: string[] = [];
    client.auth.getUser = async (token) => ({
      data: { user: token === "owner-token" ? { id: "owner-user" } : null },
      error: token === "owner-token" ? null : { message: "invalid" },
    });
    client.from = (table) => {
      if (table === "venue_attendance") {
        return queryResult([{
          id: 1, game_id: GAME_ID, game_date: "2025-07-25",
          favorite_team_id_snapshot: 1, stadium_name: "대전",
          recorded_at: "2025-07-25T12:00:00Z", source: "story_geofence",
        }]);
      }
      if (table === "profiles") return queryResult({ favorite_players: [], team_id: 1 });
      return queryResult([]);
    };
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("GetKboGameList")) {
        return new Response(JSON.stringify(gameListPayload), { status: 200 });
      }
      if (u.includes("GetScoreBoard")) {
        return new Response(JSON.stringify(scoreBoardPayload(opts.awayE, opts.homeE, {
          gameId: opts.scoreGameId,
          awayCode: opts.awayCode,
          homeCode: opts.homeCode,
        })), { status: 200 });
      }
      // Naver fallback 포함 그 외 소스는 실패 처리 — 미확인 경로 검증용.
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    return calls;
  };

  const runGet = async () => {
    // ⚠️ complete-only cache 가 이전 케이스 결과를 재사용하면 RED 가 무력화된다.
    //    (최초 작성 때 실제로 이 함정에 걸려 결손 케이스가 앞선 성공값을 그대로 반환했다.)
    const { __resetGameErrorCaches } = await import("../../src/lib/venue-stats/game-errors");
    __resetGameErrorCaches();
    const { GET } = await import("../../src/app/api/me/venue-stats/route");
    const res = await GET(new NextRequest(
      "http://localhost/api/me/venue-stats?season=2025",
      { headers: { Authorization: "Bearer owner-token" } },
    ));
    assert.equal(res.status, 200);
    return res.json();
  };

  try {
    // ── GREEN: raw 실책 → route → D7 사실값 ────────────────────────────────
    const calls = install({ awayE: "2", homeE: "0" });
    const body = await runGet();
    const d7 = body.overall.metrics.D7;

    assert.ok(
      calls.some((u) => u.includes("GetScoreBoard")),
      "route 가 실책 소스를 실제로 호출해야 함(배선 존재 증명)",
    );
    // ⚠️ 핵심 RED — route 의 gameErrors 전달을 빈 Map 으로 끊으면 여기서 FAIL.
    assert.notEqual(d7.value, null, `route 배선이 끊기면 D7 value 가 null 이 된다: ${JSON.stringify(d7)}`);
    assert.equal(d7.n, 1);
    assert.equal(d7.state, "sample_limited", "1경기는 표본 미달이지만 사실값은 보존");
    assert.equal(d7.value.knownGames, 1);
    // LG 는 원정(away) — away 칸 2가 내 팀 실책으로 귀속돼야 한다.
    assert.equal(d7.value.myTeamErrors, 2, `원정 귀속 실패: ${JSON.stringify(d7.value)}`);
    assert.equal(d7.value.opponentErrors, 0);
    assert.equal(d7.value.errorProneGames, 1, "2실책 = 발암경기 임계 도달");
    assert.equal(d7.value.worstGame.gameId, GAME_ID);
    console.log("  ✓ route actual: raw GetScoreBoard → D7 사실값(1경기·내 팀 2실책, 원정 귀속)");

    // ── RED: 같은 최종 스코어라도 다른 경기·팀 원천이면 거부 ───────────────
    install({
      awayE: "9",
      homeE: "8",
      scoreGameId: "20250725KTHH0",
      awayCode: "KT",
    });
    const wrongIdentityBody = await runGet();
    const wrongIdentityD7 = wrongIdentityBody.overall.metrics.D7;
    assert.equal(
      wrongIdentityD7.value,
      null,
      `동일 스코어 다른 경기·팀 원천은 미확인이어야 함: ${JSON.stringify(wrongIdentityD7)}`,
    );
    assert.equal(wrongIdentityD7.n, 0);
    console.log("  ✓ route actual: 동일 스코어 다른 경기·팀 원천 → D7 미확인");

    // ── RED: 소스가 E 를 비우면 미확인 — 0 으로 승격되지 않는다 ─────────────
    install({ awayE: "", homeE: "" });
    const unknownBody = await runGet();
    const unknownD7 = unknownBody.overall.metrics.D7;
    assert.equal(
      unknownD7.value, null,
      `E 결손은 미확인이어야 함(0 승격 금지): ${JSON.stringify(unknownD7)}`,
    );
    assert.equal(unknownD7.n, 0);
    assert.equal(
      (unknownD7.coverage as { unknownErrorGames?: number }).unknownErrorGames, 1,
      "미확인 경기 수를 coverage 로 노출",
    );
    console.log("  ✓ route actual: 소스 E 결손 → D7 미확인(0 으로 승격하지 않음)");
  } finally {
    client.auth.getUser = originalGetUser;
    client.from = originalFrom;
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  await rpcDbRegression();
  await seasonUniverseFailClosedRegression();
  await routeShapeRegression();
  await routeEligibleAttendanceRegression();
  await routeGameErrorsWiringRegression();
  console.log("\n결과: S1b DB/RPC + 시즌 우주 fail-closed(gate1/2/3) + owner-auth route actual + D7 실책 route 배선 PASS");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
