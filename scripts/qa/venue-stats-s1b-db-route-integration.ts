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
import type { SeasonGameFetcher } from "@/lib/crawler/season-games-cache";
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
  const { fetchSeasonAggregates } = await import("../../src/app/api/me/venue-stats/route");
  const { collectSeasonGameUniverse } = await import("../../src/lib/crawler/season-games-cache");

  // 수집 완전 우주(2경기) — 각각 서로 다른 game-bearing 날짜.
  const GAME_A = "20260614LGOB0";
  const GAME_B = "20260615KTSS0";
  const DATE_A = "20260614";
  const DATE_B = "20260615";
  const universeGames: Record<string, KboGame[]> = {
    [DATE_A]: [makeFinalGame(GAME_A)],
    [DATE_B]: [makeFinalGame(GAME_B)],
  };
  const fullFetcher: SeasonGameFetcher = async (date) => universeGames[date] ?? [];

  // 실제 RPC 루프백—전달받은 우주를 그대로 games로 반환(complete=true), teams 빈 집합.
  const faithfulRpc = async (args: {
    p_games: Array<{ gameId: string; gameDate: string }>;
  }) => ({
    data: {
      games: args.p_games.map((g) => ({ ...g, complete: true })),
      teams: [] as unknown[],
    },
    error: null,
  });

  // ─ GREEN: 완전 우주 + exact-set 일치 RPC → seasonGames 비비어있음(2건) ─
  const green = await fetchSeasonAggregates(2026, { fetcher: fullFetcher, rpc: faithfulRpc });
  assert.notEqual(green.seasonGames, null);
  assert.equal(green.seasonGames!.length, 2);
  console.log("  ✓ route gate GREEN: 완전 우주(날짜 실패 0) + exact-set 일치 → seasonGames 2건");

  // ─ gate1 RED (일자 1건 reject — off-day transient): 다른 날짜는 성공해도 전체 fail-closed ─
  const rejectOffDay: SeasonGameFetcher = async (date) => {
    if (date === "20260401") throw new Error("transient fetch fail");
    return universeGames[date] ?? [];
  };
  const red1 = await fetchSeasonAggregates(2026, { fetcher: rejectOffDay, rpc: faithfulRpc });
  assert.equal(red1.seasonGames, null);
  assert.equal(red1.teamSeasonTotals, null);
  console.log("  ✓ route gate1 RED: 일자 1건 reject → complete=false → seasonGames null (상태 fail-closed)");

  // ─ gate1 RED (non-empty partial — game-bearing 날짜 reject): 다른 경기는 수집되어 non-empty지만 null ─
  const rejectGameDate: SeasonGameFetcher = async (date) => {
    if (date === DATE_B) throw new Error("transient fetch fail");
    return universeGames[date] ?? [];
  };
  const red2 = await fetchSeasonAggregates(2026, { fetcher: rejectGameDate, rpc: faithfulRpc });
  assert.equal(red2.seasonGames, null);
  // 확인: collection은 non-empty(GAME_A 수집)지만 complete=false임을 helper actual로 증명.
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
      teams: [] as unknown[],
    },
    error: null,
  });
  const red3 = await fetchSeasonAggregates(2026, { fetcher: fullFetcher, rpc: substitutingRpc });
  assert.equal(red3.seasonGames, null);
  console.log("  ✓ route gate2 RED: 동수 ID 치환(len 같음) → gameId+gameDate exact-set 불일치 → seasonGames null");

  // ─ GREEN 원복: 완전 우주 + 일치 RPC 다시 → non-null(fault 제거 시만 열림) ─
  const restored = await fetchSeasonAggregates(2026, { fetcher: fullFetcher, rpc: faithfulRpc });
  assert.notEqual(restored.seasonGames, null);
  console.log("  ✓ route gate GREEN 원복: fault 제거 → seasonGames 복구(완전 우주에서만 GREEN)");
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
  const contrastFetcher: SeasonGameFetcher = async (date) => gamesByDate[date] ?? [];
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
