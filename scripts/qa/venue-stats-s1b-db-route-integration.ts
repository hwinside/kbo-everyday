/**
 * 직관 통계 S1b DB RPC(PGlite/PG17) + owner-auth GET route actual shape 회귀.
 * 실행: npm run qa:venue-stats-s1b-db-route
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import {
  canonicalPayloadHash,
  type CanonicalRowInput,
} from "@/lib/game-logs/completeness";
import { METRIC_IDS } from "@/lib/venue-stats/types";

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
 * backfill 대조군 우주 회귀 — 2026 정규 final 실데이터 dry-run(480 = 472 complete / 8 incomplete)과
 * 동형의 계약을 고정: 우주 480경기 중 472만 ledger complete여도 games는 항상 480개로 반환되고
 * 나머지 8경기는 complete=false로 강등된다(우주 누락 0).
 */
async function backfillContrastRegression(db: PGlite) {
  const universe: Array<{ gameId: string; gameDate: string }> = [];
  for (let i = 0; i < 480; i++) {
    const day = new Date(Date.UTC(2026, 3, 1 + Math.floor(i / 5)));
    const date = day.toISOString().slice(0, 10);
    const gameId = `${date.replaceAll("-", "")}CT${String(i).padStart(3, "0")}`;
    universe.push({ gameId, gameDate: date });
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
  console.log("  ✓ RPC backfill 대조군: 우주 480 = 472 complete / 8 incomplete (누락 0, 팀 합계 472)");
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
  await routeShapeRegression();
  console.log("\n결과: S1b DB/RPC + owner-auth route actual PASS");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
