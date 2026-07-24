import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const NOW = "2026-07-22T00:00:00Z";
const BACKUP_REF = "supabase-physical:1@2026-07-21T18:00:00Z";

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

interface PreviewResult {
  coverageMismatches: {
    pageViews: number;
    userDays: number;
    pageDwell: number;
    pageDwellSessions: number;
    pageDwellDistribution: number;
  };
  expiredRollups: {
    trafficDailyVisitors: number;
    pageViewUserDays: number;
    dwellSessionSlices: number;
    appVersionDevices: number;
  };
}

async function previewFull(db: PGlite): Promise<PreviewResult> {
  const result = await db.query<{ result: PreviewResult }>(
    `SELECT admin_telemetry_retention_preview('${NOW}'::timestamptz) AS result`,
  );
  return result.rows[0]!.result;
}

async function preview(db: PGlite) {
  return (await previewFull(db)).coverageMismatches;
}

async function main() {
  const db = new PGlite();
  await db.waitReady;

  try {
    const version = await db.query<{ server_version: string }>(
      "SHOW server_version",
    );
    assert.match(
      version.rows[0]!.server_version,
      /^17\./,
      "DB regression must run on PostgreSQL 17",
    );

    await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;

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

    INSERT INTO admin_page_views (
      created_at, path, platform, visitor_id, user_id, app_version
    ) VALUES
      ('2026-06-01T01:00:00Z', '/games/20260601LGOB', 'web', 'visitor-a',
       '11111111-1111-1111-1111-111111111111', NULL),
      ('2026-06-01T01:01:00Z', '/qa/skip-delete', 'web', 'visitor-a',
       '11111111-1111-1111-1111-111111111111', NULL),
      ('2025-07-01T01:00:00Z', '/home', 'ios_native', 'old-device', NULL, '0.9.0'),
      ('2025-07-21T15:00:00Z', '/home', 'ios_native', 'boundary-device', NULL, '1.0.0'),
      ('2026-06-01T03:00:00Z', '/home', 'ios_native', 'new-device', NULL, '2.0.0'),
      ('2025-07-01T02:00:00Z', '/games/20250701SSLT', 'web', 'visitor-lifetime',
       '44444444-4444-4444-4444-444444444444', NULL);

    INSERT INTO admin_page_dwell (
      created_at, visitor_id, platform, dwell_ms
    ) VALUES
      ('2026-06-01T01:00:00Z', 'visitor-a', 'web', 1000),
      ('2026-06-01T01:01:00Z', 'visitor-b', 'web', 2000),
      ('2026-06-01T01:02:00Z', 'visitor-c', 'web', 9000),
      ('2026-06-02T01:00:00Z', 'visitor-boundary', 'web', 1000),
      ('2026-06-02T01:31:00Z', 'visitor-boundary', 'web', 2000);
  `);

    await apply(db, migration("20260721_admin_traffic_page_view_rollup.sql"));
    await apply(db, migration("20260721_admin_traffic_dwell_rollup.sql"));
    await apply(db, migration("20260722_admin_telemetry_retention.sql"));

    await db.exec(`
    INSERT INTO admin_traffic_daily_visitors (day_kst, platform, visitor_id, pv)
    VALUES ('2026-05-01', 'web', 'already-purged', 1);

    INSERT INTO admin_page_view_user_days (day_kst, user_id, page_views, game_ids)
    VALUES (
      '2026-05-01',
      '22222222-2222-2222-2222-222222222222',
      1,
      ARRAY['20260501LGOB']
    );

    WITH historical_session AS (
      INSERT INTO admin_dwell_sessions (visitor_id, session_start, session_end)
      VALUES ('already-purged', '2026-05-01T01:00:00Z', '2026-05-01T01:00:00Z')
      RETURNING id
    )
    INSERT INTO admin_dwell_session_slices (
      session_id, platform, day_kst, dwell_ms, event_count
    )
    SELECT id, 'web', '2026-05-01', 500, 1
    FROM historical_session;
  `);

    const initialPreview = await previewFull(db);
    assert.deepEqual(
      initialPreview.coverageMismatches,
      {
        pageViews: 0,
        userDays: 0,
        pageDwell: 0,
        pageDwellSessions: 0,
        pageDwellDistribution: 0,
      },
      "retained rollups whose raw was already purged must not count as mismatches",
    );
    assert.deepEqual(
      initialPreview.expiredRollups,
      {
        trafficDailyVisitors: 2,
        pageViewUserDays: 1,
        dwellSessionSlices: 0,
        appVersionDevices: 1,
      },
      "preview must count app-version devices past the KST rollup cutoff (삼순 P1-1)",
    );
    assert.equal(
      await scalar(
        db,
        `SELECT count(*)::int AS value FROM admin_user_game_lifetime
         WHERE user_id = '44444444-4444-4444-4444-444444444444'
           AND first_game_id = '20250701SSLT'
           AND first_game_day_kst = '2025-07-01'`,
      ),
      1,
      "backfill must materialize lifetime first game visits",
    );

    const rawViewsBefore = await scalar(
      db,
      "SELECT count(*)::int AS value FROM admin_page_views",
    );
    const rawDwellBefore = await scalar(
      db,
      "SELECT count(*)::int AS value FROM admin_page_dwell",
    );

    await db.exec(`
    BEGIN;

    INSERT INTO admin_traffic_daily_visitors (
      day_kst, platform, visitor_id, pv
    ) VALUES ('2026-06-01', 'web', 'rollup-only-visitor', 777);

    INSERT INTO admin_page_view_user_days (
      day_kst, user_id, page_views, game_ids
    ) VALUES (
      '2026-06-01',
      '33333333-3333-3333-3333-333333333333',
      777,
      ARRAY['rollup-only-game']
    );
  `);

    assert.deepEqual(
      await preview(db),
      {
        pageViews: 1,
        userDays: 1,
        pageDwell: 0,
        pageDwellSessions: 0,
        pageDwellDistribution: 0,
      },
      "rollup-only visitor/user rows on a raw candidate day must fail coverage",
    );

    await db.exec(`
    DO $$
    BEGIN
      PERFORM admin_telemetry_retention_run(
        true,
        '${BACKUP_REF}',
        '${NOW}'::timestamptz
      );
      RAISE EXCEPTION 'expected rollup-only coverage mismatch';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM NOT LIKE 'raw-to-rollup coverage mismatch:%' THEN
          RAISE;
        END IF;
    END
    $$;
  `);

    assert.equal(
      await scalar(db, "SELECT count(*)::int AS value FROM admin_page_views"),
      rawViewsBefore,
      "rollup-only coverage failure must preserve raw page views",
    );
    assert.equal(
      await scalar(db, "SELECT count(*)::int AS value FROM admin_page_dwell"),
      rawDwellBefore,
      "rollup-only coverage failure must preserve raw dwell",
    );
    assert.equal(
      await scalar(
        db,
        "SELECT count(*)::int AS value FROM admin_telemetry_retention_runs",
      ),
      0,
      "rollup-only coverage failure must not leave an audit success row",
    );

    await db.exec("ROLLBACK;");

    await db.exec(`
    BEGIN;

    UPDATE admin_dwell_session_slices AS survivor
    SET dwell_ms = survivor.dwell_ms + collapsed.dwell_ms,
        event_count = survivor.event_count + collapsed.event_count
    FROM admin_dwell_session_slices AS collapsed
    WHERE survivor.session_id = (
        SELECT id FROM admin_dwell_sessions
        WHERE visitor_id = 'visitor-boundary'
        ORDER BY session_start
        LIMIT 1
      )
      AND collapsed.session_id = (
        SELECT id FROM admin_dwell_sessions
        WHERE visitor_id = 'visitor-boundary'
        ORDER BY session_start DESC
        LIMIT 1
      )
      AND survivor.platform = collapsed.platform
      AND survivor.day_kst = collapsed.day_kst;

    UPDATE admin_dwell_sessions
    SET session_end = (
      SELECT max(session_end) FROM admin_dwell_sessions
      WHERE visitor_id = 'visitor-boundary'
    )
    WHERE id = (
      SELECT id FROM admin_dwell_sessions
      WHERE visitor_id = 'visitor-boundary'
      ORDER BY session_start
      LIMIT 1
    );

    DELETE FROM admin_dwell_sessions
    WHERE id = (
      SELECT id FROM admin_dwell_sessions
      WHERE visitor_id = 'visitor-boundary'
      ORDER BY session_start DESC
      LIMIT 1
    );
  `);

    const collapsedBoundary = await preview(db);
    assert.equal(collapsedBoundary.pageDwell, 0);
    assert.equal(
      collapsedBoundary.pageDwellSessions,
      1,
      "independent raw session count must catch a 2-to-1 boundary collapse",
    );
    assert(collapsedBoundary.pageDwellDistribution > 0);

    await db.exec(`
    DO $$
    BEGIN
      PERFORM admin_telemetry_retention_run(
        true,
        '${BACKUP_REF}',
        '${NOW}'::timestamptz
      );
      RAISE EXCEPTION 'expected session boundary mismatch';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM NOT LIKE 'raw-to-rollup coverage mismatch:%' THEN
          RAISE;
        END IF;
    END
    $$;
  `);

    assert.equal(
      await scalar(db, "SELECT count(*)::int AS value FROM admin_page_views"),
      rawViewsBefore,
      "session boundary failure must preserve raw page views",
    );
    assert.equal(
      await scalar(db, "SELECT count(*)::int AS value FROM admin_page_dwell"),
      rawDwellBefore,
      "session boundary failure must preserve raw dwell",
    );
    assert.equal(
      await scalar(
        db,
        "SELECT count(*)::int AS value FROM admin_telemetry_retention_runs",
      ),
      0,
      "session boundary failure must not leave an audit success row",
    );

    await db.exec("ROLLBACK;");

    assert.deepEqual(
      await preview(db),
      {
        pageViews: 0,
        userDays: 0,
        pageDwell: 0,
        pageDwellSessions: 0,
        pageDwellDistribution: 0,
      },
      "coverage must recover after rolling back the boundary tamper",
    );

    await db.exec(`
    UPDATE admin_dwell_session_slices
    SET dwell_ms = 4000
    WHERE day_kst = '2026-06-01';
  `);

    assert.deepEqual(
      await preview(db),
      {
        pageViews: 0,
        userDays: 0,
        pageDwell: 0,
        pageDwellSessions: 0,
        pageDwellDistribution: 3,
      },
      "equal-count/equal-sum session distribution corruption must fail coverage",
    );

    await db.exec(`
    DO $$
    BEGIN
      PERFORM admin_telemetry_retention_run(
        true,
        '${BACKUP_REF}',
        '${NOW}'::timestamptz
      );
      RAISE EXCEPTION 'expected session distribution mismatch';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM NOT LIKE 'raw-to-rollup coverage mismatch:%' THEN
          RAISE;
        END IF;
    END
    $$;
  `);

    assert.equal(
      await scalar(db, "SELECT count(*)::int AS value FROM admin_page_views"),
      rawViewsBefore,
      "session distribution failure must preserve raw page views",
    );
    assert.equal(
      await scalar(db, "SELECT count(*)::int AS value FROM admin_page_dwell"),
      rawDwellBefore,
      "session distribution failure must preserve raw dwell",
    );
    assert.equal(
      await scalar(
        db,
        "SELECT count(*)::int AS value FROM admin_telemetry_retention_runs",
      ),
      0,
      "session distribution failure must not leave an audit success row",
    );

    await db.exec(`
    WITH ordered AS (
      SELECT session_id,
             row_number() OVER (ORDER BY session_id) AS position
      FROM admin_dwell_session_slices
      WHERE day_kst = '2026-06-01'
    )
    UPDATE admin_dwell_session_slices AS slices
    SET dwell_ms = CASE ordered.position
      WHEN 1 THEN 1000
      WHEN 2 THEN 2000
      ELSE 9000
    END
    FROM ordered
    WHERE slices.session_id = ordered.session_id
      AND slices.day_kst = '2026-06-01';

    UPDATE admin_dwell_session_slices
    SET platform = 'ios'
    WHERE session_id = (
      SELECT min(session_id) FROM admin_dwell_session_slices
      WHERE day_kst = '2026-06-01'
    );
  `);

    const platformTamper = await preview(db);
    assert.equal(
      platformTamper.pageDwellSessions,
      2,
      "platform session-count corruption must fail both affected platforms",
    );
    assert(platformTamper.pageDwellDistribution > 0);

    await db.exec(`
    UPDATE admin_dwell_session_slices SET platform = 'web';

    UPDATE admin_dwell_session_slices
    SET dwell_ms = dwell_ms + 777
    WHERE session_id = (
      SELECT min(session_id) FROM admin_dwell_session_slices
      WHERE day_kst = '2026-06-01'
    );

    UPDATE admin_page_view_user_days
    SET game_ids = array_append(game_ids, 'fake-game-id')
    WHERE day_kst = '2026-06-01';
  `);

    assert.deepEqual(
      await preview(db),
      {
        pageViews: 0,
        userDays: 1,
        pageDwell: 1,
        pageDwellSessions: 0,
        pageDwellDistribution: 1,
      },
      "dwell sum and game-id superset corruption must fail coverage",
    );

    await db.exec(`
    DO $$
    BEGIN
      PERFORM admin_telemetry_retention_run(
        true,
        '${BACKUP_REF}',
        '${NOW}'::timestamptz
      );
      RAISE EXCEPTION 'expected coverage mismatch';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM NOT LIKE 'raw-to-rollup coverage mismatch:%' THEN
          RAISE;
        END IF;
    END
    $$;
  `);

    assert.equal(
      await scalar(db, "SELECT count(*)::int AS value FROM admin_page_views"),
      rawViewsBefore,
      "coverage failure must preserve raw page views",
    );
    assert.equal(
      await scalar(db, "SELECT count(*)::int AS value FROM admin_page_dwell"),
      rawDwellBefore,
      "coverage failure must preserve raw dwell",
    );

    await db.exec(`
    UPDATE admin_dwell_session_slices
    SET dwell_ms = dwell_ms - 777
    WHERE session_id = (
      SELECT min(session_id) FROM admin_dwell_session_slices
      WHERE day_kst = '2026-06-01'
    );

    UPDATE admin_page_view_user_days
    SET game_ids = array_remove(game_ids, 'fake-game-id')
    WHERE day_kst = '2026-06-01';

    CREATE FUNCTION qa_skip_one_page_delete()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.path = '/qa/skip-delete' THEN
        RETURN NULL;
      END IF;
      RETURN OLD;
    END
    $$;

    CREATE TRIGGER trg_qa_skip_one_page_delete
      BEFORE DELETE ON admin_page_views
      FOR EACH ROW EXECUTE FUNCTION qa_skip_one_page_delete();
  `);

    assert.deepEqual(
      await preview(db),
      {
        pageViews: 0,
        userDays: 0,
        pageDwell: 0,
        pageDwellSessions: 0,
        pageDwellDistribution: 0,
      },
      "coverage must recover after tamper restoration",
    );

    await db.exec(`
    DO $$
    BEGIN
      PERFORM admin_telemetry_retention_run(
        true,
        '${BACKUP_REF}',
        '${NOW}'::timestamptz
      );
      RAISE EXCEPTION 'expected delete count mismatch';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM NOT LIKE 'raw delete count mismatch:%' THEN
          RAISE;
        END IF;
    END
    $$;
  `);

    assert.equal(
      await scalar(db, "SELECT count(*)::int AS value FROM admin_page_views"),
      rawViewsBefore,
      "late delete-count failure must roll back every page-view delete",
    );
    assert.equal(
      await scalar(db, "SELECT count(*)::int AS value FROM admin_page_dwell"),
      rawDwellBefore,
      "late delete-count failure must roll back every dwell delete",
    );
    assert.equal(
      await scalar(
        db,
        "SELECT count(*)::int AS value FROM admin_telemetry_retention_runs",
      ),
      0,
      "failed execution must not leave an audit success row",
    );

    await db.exec(`
    DROP TRIGGER trg_qa_skip_one_page_delete ON admin_page_views;
    DROP FUNCTION qa_skip_one_page_delete();
  `);

    const runResult = await db.query<{
      result: { deleted: Record<string, number> };
    }>(
      `SELECT admin_telemetry_retention_run(true, '${BACKUP_REF}', '${NOW}'::timestamptz) AS result`,
    );
    const deleted = runResult.rows[0]!.result.deleted;
    assert.equal(
      deleted.appVersionDevices,
      1,
      "execute must delete and audit expired app-version devices (삼순 P1-1)",
    );
    assert.equal(deleted.pageViews, rawViewsBefore);
    assert.equal(
      await scalar(
        db,
        `SELECT count(*)::int AS value FROM admin_app_version_devices
         WHERE last_seen < '2025-07-21T15:00:00Z'::timestamptz`,
      ),
      0,
      "no app-version device older than the KST rollup cutoff may survive execute",
    );
    assert.equal(
      await scalar(
        db,
        `SELECT count(*)::int AS value FROM admin_app_version_devices
         WHERE visitor_id IN ('boundary-device', 'new-device')`,
      ),
      2,
      "devices at/after the KST rollup cutoff boundary must survive",
    );
    assert.equal(
      await scalar(
        db,
        "SELECT count(*)::int AS value FROM admin_page_view_user_days WHERE day_kst < '2025-07-22'",
      ),
      0,
      "user-day rollups past 365 days must be purged",
    );
    assert.equal(
      await scalar(
        db,
        `SELECT count(*)::int AS value FROM admin_user_game_lifetime
         WHERE user_id = '44444444-4444-4444-4444-444444444444'`,
      ),
      1,
      "lifetime activation evidence must survive the 365-day user-day purge (삼순 P1-2)",
    );
    assert.equal(
      await scalar(db, "SELECT count(*)::int AS value FROM admin_user_game_lifetime"),
      2,
      "lifetime rows must be untouched by retention execute",
    );
    assert.equal(
      await scalar(
        db,
        "SELECT count(*)::int AS value FROM admin_telemetry_retention_runs",
      ),
      1,
      "successful execute must leave exactly one audit row",
    );

    console.log(
      "PASS PG17 retention DB regression: coverage gates, app-version purge, lifetime activation survival and transactional rollback",
    );
  } finally {
    await db.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
