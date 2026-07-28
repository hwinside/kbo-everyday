// Regression for the retention coverage-guard fix (20260728).
//
// Account deletion runs ON DELETE SET NULL on admin_page_views.user_id
// (20260727), so a deleted account's raw page-views survive as NULL-user rows
// while its per-user rollup persists. Before the fix that rollup row was
// reported as a coverage mismatch on days whose raw is still purge-eligible,
// permanently blocking the fail-closed retention purge.
//
// This test proves, on PostgreSQL 17 (PGlite), the three cases 삼순 required:
//   1. Reconciled deleted-account rollup-only rows pass coverage (0 mismatch)
//      where the same seed FAILS under the pre-fix function.
//   2. Fabricated rollup-only rows on a candidate day still FAIL coverage and
//      the run() purge rolls back raw + audit — for a still-existing user AND
//      for deleted-account demand that exceeds its anonymized raw pool.
//   3. Raw-only rows and value mismatches still FAIL coverage.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const NOW = "2026-07-22T00:00:00Z"; // raw cutoff 2026-06-22 KST, rollup cutoff 2025-07-22
const BACKUP_REF = "supabase-physical:1@2026-07-21T18:00:00Z";

const LIVE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LIVE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const DELETED_D = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const DELETED_BIG = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function migration(name: string) {
  return readFileSync(resolve("supabase/migrations", name), "utf8");
}

async function apply(db: PGlite, sql: string) {
  await db.exec(`BEGIN;\n${sql}\nCOMMIT;`);
}

async function scalar(db: PGlite, sql: string): Promise<number> {
  const result = await db.query<{ value: number }>(sql);
  return Number(result.rows[0]?.value);
}

interface Coverage {
  pageViews: number;
  userDays: number;
  pageDwell: number;
  pageDwellSessions: number;
  pageDwellDistribution: number;
}

async function coverage(db: PGlite): Promise<Coverage> {
  const result = await db.query<{ result: { coverageMismatches: Coverage } }>(
    `SELECT admin_telemetry_retention_preview('${NOW}'::timestamptz) AS result`,
  );
  return result.rows[0]!.result.coverageMismatches;
}

async function expectCoverageRaise(db: PGlite) {
  await db.exec(`
    DO $$
    BEGIN
      PERFORM admin_telemetry_retention_run(
        true, '${BACKUP_REF}', '${NOW}'::timestamptz
      );
      RAISE EXCEPTION 'expected coverage mismatch to block purge';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM NOT LIKE 'raw-to-rollup coverage mismatch:%' THEN
          RAISE;
        END IF;
    END
    $$;
  `);
}

async function main() {
  const db = new PGlite();
  await db.waitReady;

  try {
    const version = await db.query<{ server_version: string }>("SHOW server_version");
    assert.match(version.rows[0]!.server_version, /^17\./, "must run on PostgreSQL 17");

    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;

      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      -- Only the "live" accounts exist; DELETED_D / DELETED_BIG were deleted.
      INSERT INTO auth.users (id) VALUES ('${LIVE_A}'), ('${LIVE_B}');

      CREATE TABLE admin_page_views (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        created_at timestamptz NOT NULL,
        path text NOT NULL,
        platform text,
        visitor_id text NOT NULL,
        user_id uuid,
        app_version text
      );
      CREATE TABLE admin_page_dwell (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        created_at timestamptz NOT NULL,
        visitor_id text NOT NULL,
        platform text,
        dwell_ms bigint NOT NULL
      );

      -- All raw on a single candidate day (2026-06-10, < 2026-06-22 cutoff).
      -- Live A: 1 attributed page view.
      -- Deleted D: 3 rows already anonymized to user_id = NULL (ON DELETE SET
      --   NULL). They leave raw_user_days but remain in the NULL-user pool.
      INSERT INTO admin_page_views (created_at, path, platform, visitor_id, user_id)
      VALUES
        ('2026-06-10T01:00:00Z', '/home', 'web', 'va', '${LIVE_A}'),
        ('2026-06-10T02:00:00Z', '/home', 'web', 'vd', NULL),
        ('2026-06-10T02:01:00Z', '/home', 'web', 'vd', NULL),
        ('2026-06-10T02:02:00Z', '/home', 'web', 'vd', NULL),
        -- A celeb page view must NOT count toward the anonymized pool.
        ('2026-06-10T03:00:00Z', '/_celeb/x', 'web', 'vc', NULL);
    `);

    await apply(db, migration("20260721_admin_traffic_page_view_rollup.sql"));
    await apply(db, migration("20260721_admin_traffic_dwell_rollup.sql"));
    await apply(db, migration("20260722_admin_telemetry_retention.sql"));

    // The migrations backfill admin_traffic_daily_visitors (va=1, vd=3) and
    // admin_page_view_user_days (live A = 1) from the raw rows above. Only the
    // deleted account's rollup must be added by hand: its raw is NULL-user so
    // the user-day backfill skipped it, but the aggregate persists in prod.
    // Its 3 page views are exactly reconciled by the 3 NULL-user pool rows.
    await db.exec(`
      INSERT INTO admin_page_view_user_days (day_kst, user_id, page_views, game_ids)
      VALUES ('2026-06-10', '${DELETED_D}', 3, '{}');
    `);

    // --- Scenario 1: pre-fix FAILS, post-fix PASSES -----------------------
    const beforeFix = await coverage(db);
    assert.equal(
      beforeFix.userDays,
      1,
      "pre-fix guard must flag the deleted-account rollup-only row as a mismatch",
    );

    await apply(db, migration("20260728_retention_coverage_guard_fix.sql"));

    assert.deepEqual(
      await coverage(db),
      { pageViews: 0, userDays: 0, pageDwell: 0, pageDwellSessions: 0, pageDwellDistribution: 0 },
      "S1: reconciled deleted-account rollup-only rows must pass coverage post-fix",
    );

    const rawBefore = await scalar(db, "SELECT count(*)::int AS value FROM admin_page_views");
    const auditBefore = await scalar(
      db,
      "SELECT count(*)::int AS value FROM admin_telemetry_retention_runs",
    );

    // --- Scenario 2a: deleted-account demand exceeding the pool FAILS ------
    await db.exec("BEGIN;");
    await db.exec(`
      INSERT INTO admin_page_view_user_days (day_kst, user_id, page_views, game_ids)
      VALUES ('2026-06-10', '${DELETED_BIG}', 999, '{}');
    `);
    // Whole-day deleted demand (3 + 999 = 1002) now exceeds the pool (3), so
    // NO deleted-account row on that day is excused: both fail (fail-closed).
    assert.equal(
      (await coverage(db)).userDays,
      2,
      "S2a: deleted demand over the anonymized pool must fail every such row",
    );
    await expectCoverageRaise(db);
    assert.equal(
      await scalar(db, "SELECT count(*)::int AS value FROM admin_page_views"),
      rawBefore,
      "S2a: fabricated-demand coverage failure must preserve raw page views",
    );
    assert.equal(
      await scalar(db, "SELECT count(*)::int AS value FROM admin_telemetry_retention_runs"),
      auditBefore,
      "S2a: coverage failure must not leave an audit success row",
    );
    await db.exec("ROLLBACK;");

    // --- Scenario 2b: rollup-only row for a STILL-EXISTING user FAILS ------
    await db.exec("BEGIN;");
    await db.exec(`
      INSERT INTO admin_page_view_user_days (day_kst, user_id, page_views, game_ids)
      VALUES ('2026-06-10', '${LIVE_B}', 500, '{}');
    `);
    assert.equal(
      (await coverage(db)).userDays,
      1,
      "S2b: a rollup-only user-day for a live account must fail (PR #765 invariant)",
    );
    await expectCoverageRaise(db);
    assert.equal(
      await scalar(db, "SELECT count(*)::int AS value FROM admin_page_views"),
      rawBefore,
      "S2b: live-user rollup-only failure must preserve raw page views",
    );
    await db.exec("ROLLBACK;");

    // --- Scenario 3: raw-only and value mismatch still FAIL ----------------
    // Value mismatch: live A's rollup count no longer equals its raw (1 vs 5).
    await db.exec("BEGIN;");
    await db.exec(
      `UPDATE admin_page_view_user_days SET page_views = 5 WHERE user_id = '${LIVE_A}';`,
    );
    assert.equal(
      (await coverage(db)).userDays,
      1,
      "S3: a rollup page-view value diverging from raw must fail coverage",
    );
    await expectCoverageRaise(db);
    await db.exec("ROLLBACK;");

    // Raw-only: live A still has raw on 2026-06-10 but its rollup user-day is
    // gone (data that would be silently lost on purge). A still exists in
    // auth.users, so this is never mistaken for an anonymized deletion.
    await db.exec("BEGIN;");
    await db.exec(
      `DELETE FROM admin_page_view_user_days WHERE user_id = '${LIVE_A}';`,
    );
    const rawOnly = await coverage(db);
    assert.equal(rawOnly.pageViews, 0, "S3: visitor rollup stays consistent for the raw-only probe");
    assert.equal(
      rawOnly.userDays,
      1,
      "S3: raw user-day with no rollup must fail coverage (would lose data on purge)",
    );
    await expectCoverageRaise(db);
    await db.exec("ROLLBACK;");

    // Coverage recovers to clean baseline after every rollback.
    assert.deepEqual(
      await coverage(db),
      { pageViews: 0, userDays: 0, pageDwell: 0, pageDwellSessions: 0, pageDwellDistribution: 0 },
      "coverage must return to 0 after the tamper transactions roll back",
    );

    console.log(
      "PASS PG17 retention coverage-guard fix: deleted-account reconciliation passes, fabricated/live rollup-only and raw-only/value mismatches still fail-closed",
    );
  } finally {
    await db.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
