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

  const green = await db.query<{ payload: {
    games: Array<{ gameId: string; complete: boolean }>;
    teams: Array<{ teamId: number; completeGames: number; ab: number; h: number; outs: number }>;
  } }>("select venue_stats_season_team_aggregates(2026) as payload");
  const payload = green.rows[0].payload;
  assert.deepEqual(payload.games, [{ gameId: GAME_ID, gameDate: "2026-06-14", complete: true }]);
  assert.deepEqual(payload.teams, [{
    teamId: 1, completeGames: 1, ab: 4, h: 2, hr: 1, outs: 18, er: 2, hAllowed: 5,
  }]);
  console.log("  ✓ RPC GREEN: TS canonical hash = PG17 hash, complete 경기만 팀 시즌 합계 산입");

  await db.query("update player_game_logs set h=0 where game_id=$1 and kbo_id='90001'", [GAME_ID]);
  const red = await db.query<{ payload: {
    games: Array<{ complete: boolean }>;
    teams: unknown[];
  } }>("select venue_stats_season_team_aggregates(2026) as payload");
  assert.equal(red.rows[0].payload.games[0].complete, false);
  assert.deepEqual(red.rows[0].payload.teams, []);
  console.log("  ✓ RPC RED: 단일 stat drift → complete=false, 시즌 분모 누출 0");

  await db.query("update player_game_logs set h=2 where game_id=$1 and kbo_id='90001'", [GAME_ID]);
  const restored = await db.query<{ payload: { games: Array<{ complete: boolean }> } }>(
    "select venue_stats_season_team_aggregates(2026) as payload",
  );
  assert.equal(restored.rows[0].payload.games[0].complete, true);
  console.log("  ✓ RPC GREEN 원복: complete=true");
  await db.close();
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
