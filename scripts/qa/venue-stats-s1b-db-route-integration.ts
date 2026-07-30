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

/** collection이 status/date/gameId만 읽으므로 최소 필드만 채우고 KboGame으로 캐스트. */
function makeFinalGame(gameId: string): KboGame {
  return {
    gameId,
    date: gameId.slice(0, 8),
    time: "18:30",
    status: "final",
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
  assert.notEqual(green.teamSeasonTotals, null);
  assert.equal(green.teamSeasonTotals!.size, 4);
  console.log("  ✓ route gate GREEN: 완전 우주(날짜 실패 0) + exact-set 일치 + teams exact → seasonGames 2건");

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
  // ─ P0-1 verified-empty (actual global fetch 경유) ─
  await verifiedEmptyActualRegression();
  // ─ 삼순 4차 P0-1 series-aware verified-empty (3/12 유형 실소스 fixture) ─
  await seriesAwareVerifiedEmptyRegression();
  // ─ P0-3 complete-only 캐시 + single-flight (fetch 카운트 계측) ─
  await cacheAndSingleFlightRegression(routeMod, universeGames);
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
 * 삼순 P0-1 — verified-empty. actual global fetch 경유(배열 직접 주입 아님):
 * KBO 200 game:[] soft-empty가 Naver 전-시리즈 교차확인에서 무경기 확정(verified-empty)될 때만
 * 성공, Naver에 경기가 있으면(=KBO가 정규경기를 soft-drop) unverified → fail-closed.
 */
async function verifiedEmptyActualRegression() {
  const { collectSeasonGameUniverse } = await import("../../src/lib/crawler/season-games-cache");
  const { fetchSeasonAggregates, __resetSeasonAggregatesCaches } = await import(
    "../../src/app/api/me/venue-stats/route"
  );
  const GAME_DATE = "20260614";
  const GAME_ID = "20260614LGOB0"; // LG(1)·OB(2)
  const FAULT_DATE = "20260615";

  // RED — fault date: KBO 200 game:[] + Naver 전-시리즈에 경기 존재 → unverified soft-empty.
  let restore = installKboNaverFetchMock({
    gameDate: GAME_DATE, gameId: GAME_ID, faultDate: FAULT_DATE, faultNaverHasGame: true,
  });
  try {
    const red = await collectSeasonGameUniverse(2026, "0"); // 기본 fetcher=fetchSeasonUniverseDate
    assert.equal(red.complete, false, "P0-1 RED: unverified soft-empty → complete=false");
    assert.ok(red.failedDates.includes(FAULT_DATE), "fault 날짜가 failedDates에");
    assert.ok(red.games.some((g) => g.gameId === GAME_ID), "non-empty partial(진짜 경기 수집)");
    __resetSeasonAggregatesCaches();
    const redAgg = await fetchSeasonAggregates(2026, { rpc: async () => ({ data: null, error: null }) });
    assert.equal(redAgg.seasonGames, null, "P0-1 RED route: seasonGames null (fail-closed)");
  } finally {
    restore();
  }
  console.log("  ✓ P0-1 RED(actual fetch): srId=0 200 game:[] + Naver에 경기 → unverified → complete=false·seasonGames null");

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
 * 2026-03-12 실소스 유형(KBO 정규 srId=0 → []·Naver 전-시리즈 시범 5경기)이 있어도
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
  const PRESEASON_DATE = "20260312";
  // 삼순 4차 리뷰 실소스 probe(2026-03-12) 그대로 — Naver 전-시리즈 시범 5경기.
  const PRESEASON_IDS = [
    "20260312KTLT0", "20260312LGNC0", "20260312SKHT0", "20260312SSHH0", "20260312WOOB0",
  ];

  // GREEN — 3/12 유형: 시범 5경기 전부 KBO 비정규 시리즈 조회로 gameId exact 설명 → 정규 verified-empty.
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
  console.log("  ✓ P0-1 series GREEN(actual fetch): 3/12 유형(KBO 정규 []·Naver 시범 5) → 정규 verified-empty·우주에 정규만·RPC 호출");

  // RED — 진짜 실패: Naver 경기 중 1개(SKHT)가 KBO 비정규 조회로 설명 안 됨(정규 soft-drop 가능성) → fail-closed.
  restore = installSeriesAwareFetchMock({
    regularDate: REGULAR_DATE, regularGameId: REGULAR_GAME_ID,
    preseasonDate: PRESEASON_DATE, preseasonGameIds: PRESEASON_IDS,
    kboNonRegularDrops: ["20260312SKHT0"],
  });
  try {
    const red = await collectSeasonGameUniverse(2026, "0");
    assert.equal(red.complete, false, "P0-1 series RED: 미설명 Naver 경기 → unverified → complete=false");
    assert.ok(red.failedDates.includes(PRESEASON_DATE), "3/12가 failedDates에");
    __resetSeasonAggregatesCaches();
    let rpcCalled = false;
    const redAgg = await fetchSeasonAggregates(2026, {
      rpc: async () => {
        rpcCalled = true;
        return { data: null, error: null };
      },
    });
    assert.equal(redAgg.seasonGames, null, "P0-1 series RED route: seasonGames null");
    assert.equal(rpcCalled, false, "fail-closed 시 RPC 미호출");
  } finally {
    restore();
  }
  console.log("  ✓ P0-1 series RED(actual fetch): 비정규 조회로 설명 안 되는 Naver 경기 → unverified → seasonGames null·RPC 미호출");
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
  for (const method of ["select", "eq", "in", "gte", "lt", "order", "limit", "range", "maybeSingle"]) {
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

async function main() {
  await rpcDbRegression();
  await seasonUniverseFailClosedRegression();
  await routeShapeRegression();
  console.log("\n결과: S1b DB/RPC + 시즌 우주 fail-closed(gate1/2/3) + owner-auth route actual PASS");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
