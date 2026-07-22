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

async function preview(db: PGlite) {
  const result = await db.query<{
    result: {
      coverageMismatches: {
        pageViews: number;
        userDays: number;
        pageDwell: number;
        pageDwellSessions: number;
        pageDwellDistribution: number;
      };
    };
  }>(
    `SELECT admin_telemetry_retention_preview('${NOW}'::timestamptz) AS result`,
  );
  return result.rows[0]!.result.coverageMismatches;
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
       '11111111-1111-1111-1111-111111111111', NULL);

    INSERT INTO admin_page_dwell (
      created_at, visitor_id, platform, dwell_ms
    ) VALUES
      ('2026-06-01T01:00:00Z', 'visitor-a', 'web', 1000),
      ('2026-06-01T01:01:00Z', 'visitor-b', 'web', 2000),
      ('2026-06-01T01:02:00Z', 'visitor-c', 'web', 9000);
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

    assert.deepEqual(
      await preview(db),
      {
        pageViews: 0,
        userDays: 0,
        pageDwell: 0,
        pageDwellSessions: 0,
        pageDwellDistribution: 0,
      },
      "retained rollups whose raw was already purged must not count as mismatches",
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
    UPDATE admin_dwell_session_slices SET dwell_ms = 4000;
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
    SET game_ids = array_append(game_ids, 'fake-game-id');
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
    SET game_ids = array_remove(game_ids, 'fake-game-id');

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

    console.log(
      "PASS PG17 retention DB regression: exact platform/session distribution coverage and transactional rollback",
    );
  } finally {
    await db.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
