/**
 * 직관 통계 시즌 집계 RPC — 규모 회귀 (2026-08-01 사고 재발 방지).
 *
 * 사고: venue_stats_season_team_aggregates 의 CTE 가 기본 inline 되어
 * verified/team_totals 가 ledger→game_actual(17k행 string_agg + sha256)을 재참조할 때마다
 * hash 집계를 재실행했다. 경기 수에 대해 초선형으로 터져 실측 300경기 4.1s / 491경기
 * statement timeout(57014) → 시즌 집계 null → B1·B2·B4 가 상시 attendance_only
 * (`비교 데이터 준비 중`). 원장을 전부 채워도 화면이 열리지 않았다.
 *
 * 이 회귀가 고정하는 것:
 *   1) 마이그레이션 SQL 의 모든 CTE 에 MATERIALIZED 힌트가 살아있다 (되돌림 가드).
 *   2) 실 DB 에서 시즌 전체 우주(현재 ledger 전량)가 예산 안에 완료된다.
 *   3) 같은 입력의 반복 호출 결과가 결정적이고 우주 길이를 보존한다.
 *
 * (2)(3)은 service_role 자격증명이 있을 때만 실행하고, 없으면 (1)만 검사하고 skip 한다
 * (CI 에서 조용히 통과시키지 않기 위해 skip 사유를 명시 출력한다).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ⚠️ 원본 20260730 은 **이미 production 에 적용되어 있다**. 그 파일을 고치면 표준
 * migration runner 가 재실행하지 않아 schema drift 가 된다(삼순 P0).
 * 그래서 MATERIALIZED 강제는 새 migration 에서 CREATE OR REPLACE 로 덮어쓰고,
 * 이 회귀도 그 새 파일을 검사한다.
 */
const MIGRATION = join(
  process.cwd(),
  "supabase/migrations/20260801_venue_stats_team_boost_rpc_materialized.sql",
);

/** 원본 migration 은 이미 적용된 상태로 보존되어야 한다(수정 = drift). */
const APPLIED_MIGRATION = join(
  process.cwd(),
  "supabase/migrations/20260730_venue_stats_team_boost_rpc.sql",
);

/**
 * 이미 적용된 migration 은 손대지 않는다 — runner 가 재실행하지 않아
 * 파일과 실제 DB 가 어긋나는 schema drift 가 된다(삼순 P0).
 */
function assertNoAppliedMigrationDrift() {
  const applied = readFileSync(APPLIED_MIGRATION, "utf8");
  assert.ok(
    !/AS\s+MATERIALIZED/i.test(applied),
    `이미 적용된 ${APPLIED_MIGRATION} 에 MATERIALIZED 가 들어갔다 — ` +
    `runner 가 재실행하지 않으므로 schema drift. 새 migration 에서 CREATE OR REPLACE 로 덮어써라.`,
  );
  console.log("  ✓ 적용된 20260730 migration 무변경(schema drift 없음)");
}

/** 함수 본문에 선언된 CTE 는 전부 MATERIALIZED 여야 한다 (inline 되돌림 = 사고 재발). */
function assertMaterializedHints() {
  const sql = readFileSync(MIGRATION, "utf8");
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION public\.venue_stats_season_team_aggregates/,
    "새 migration 이 함수를 CREATE OR REPLACE 하지 않는다",
  );
  const body = sql.slice(sql.indexOf("AS $$"), sql.indexOf("$$;"));
  assert.ok(body.length > 0, "함수 본문을 찾지 못함");

  // `name AS (` / `name AS MATERIALIZED (` 형태의 CTE 선언을 전부 수집.
  const declared = [...body.matchAll(/(\w+)\s+AS\s+(MATERIALIZED\s+)?\(/gi)];
  const cteNames = declared.map((m) => m[1].toLowerCase());
  for (const expected of ["universe", "ledger", "game_actual", "verified", "team_totals"]) {
    assert.ok(cteNames.includes(expected), `CTE ${expected} 선언을 찾지 못함(구조 변경?)`);
  }
  const inlined = declared.filter((m) => !m[2]).map((m) => m[1]);
  assert.deepEqual(
    inlined,
    [],
    `MATERIALIZED 없는 CTE: ${inlined.join(", ")} — inline 되면 hash 집계가 재실행돼 시즌 집계가 timeout 한다`,
  );
  console.log(`  ✓ 되돌림 가드: CTE ${declared.length}개 전부 MATERIALIZED`);
}

/** 시즌 전체 우주가 예산 안에 끝나야 한다. 사고 당시 491경기 = timeout(57014). */
const BUDGET_MS = 5_000;

async function assertLiveScale() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("  … 실 DB 규모 검증 skip: NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY 없음");
    return;
  }
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // 우주 = 현재 원장 전량(운영 시즌 실규모). 화면이 쓰는 우주와 같은 스케일.
  // game_id keyset 순회 — PK(유일) 기준 전진이라 페이지 경계 중복/누락이 없다.
  const games: Array<{ gameId: string; gameDate: string }> = [];
  const pageSize = 1_000;
  let cursor: string | null = null;
  for (;;) {
    // query-guard: bounded -- 원장 PK(game_id) keyset 전진 + 고정 limit 으로 매 페이지가 바운드된다
    let query = supabase
      .from("player_game_log_ingestions")
      .select("game_id, game_date")
      .order("game_id", { ascending: true })
      .limit(pageSize);
    if (cursor !== null) query = query.gt("game_id", cursor);
    const { data, error } = await query;
    assert.equal(error, null, `원장 조회 실패: ${JSON.stringify(error)}`);
    const page = data ?? [];
    for (const r of page) {
      games.push({ gameId: r.game_id as string, gameDate: r.game_date as string });
    }
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].game_id as string;
  }
  assert.ok(games.length > 0, "원장이 비어 규모 검증 불가");
  assert.equal(
    new Set(games.map((g) => g.gameId)).size,
    games.length,
    "keyset 순회에 중복 game_id 없음",
  );

  const t0 = Date.now();
  const { data, error } = await supabase.rpc("venue_stats_season_team_aggregates", {
    p_season: 2026,
    p_games: games,
  });
  const ms = Date.now() - t0;
  assert.equal(error, null, `시즌 전체 우주 RPC 실패(${ms}ms): ${JSON.stringify(error)}`);
  const payload = data as { games?: unknown[]; teams?: unknown[] };
  assert.equal(
    payload.games?.length,
    games.length,
    "games 길이 = 우주 길이 (누락 없이 반환)",
  );
  assert.ok((payload.teams?.length ?? 0) > 0, "teams 비어있지 않음");
  assert.ok(
    ms < BUDGET_MS,
    `시즌 전체 우주 ${games.length}경기 ${ms}ms — 예산 ${BUDGET_MS}ms 초과(다시 초선형으로 터지는 중)`,
  );
  console.log(`  ✓ 실 DB 규모: ${games.length}경기 ${ms}ms (< ${BUDGET_MS}ms) · games=${payload.games?.length} teams=${payload.teams?.length}`);

  // 부분 규모에서 결정성/일관성 확인. old-vs-new byte 동치 증거는 배포 전 수동 shadow
  // verifier로 별도 수행하며, 이 committed test가 그 검증을 대신한다고 표현하지 않는다.
  for (const n of [1, 10, 97]) {
    const slice = games.slice(0, n);
    const [a, b] = await Promise.all([
      supabase.rpc("venue_stats_season_team_aggregates", { p_season: 2026, p_games: slice }),
      supabase.rpc("venue_stats_season_team_aggregates", { p_season: 2026, p_games: slice }),
    ]);
    assert.equal(a.error, null);
    assert.equal(b.error, null);
    assert.equal(
      JSON.stringify(a.data),
      JSON.stringify(b.data),
      `n=${n} 반복 호출 결과 불일치(비결정)`,
    );
    const p = a.data as { games?: unknown[] };
    assert.equal(p.games?.length, n, `n=${n} games 길이 일치`);
  }
  console.log("  ✓ 결과 일관성: n=1/10/97 반복 호출 결과 동일 · games 길이 = 우주 길이");
}

async function main() {
  console.log("venue-stats RPC 규모 회귀");
  assertNoAppliedMigrationDrift();
  assertMaterializedHints();
  await assertLiveScale();
  console.log("\n결과: RPC 규모/되돌림 가드 PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
