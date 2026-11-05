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

    -- Minimal auth.users stand-in: admin_user_game_lifetime must FK-cascade
    -- on account deletion (삼순 R2 P1).
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users (id) VALUES
      ('11111111-1111-1111-1111-111111111111'),
      ('44444444-4444-4444-4444-444444444444');

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
      ('2026-06-01T03:00:00Z', '/home', 'ios_native', 'new-device', NULL, '2.0.0'),
      ('2026-06-03T01:00:00Z', '/home', 'web', 'later-day', NULL, NULL);

    INSERT INTO admin_page_dwell (
      created_at, visitor_id, platform, dwell_ms
    ) VALUES
      ('2026-06-01T01:00:00Z', 'visitor-a', 'web', 1000),
      ('2026-06-01T01:01:00Z', 'visitor-b', 'web', 2000),
      ('2026-06-01T01:02:00Z', 'visitor-c', 'web', 9000),
      ('2026-06-01T14:59:00Z', 'visitor-midnight', 'web', 1000),
      ('2026-06-01T15:01:00Z', 'visitor-midnight', 'web', 2000),
      ('2026-06-02T01:00:00Z', 'visitor-boundary', 'web', 1000),
      ('2026-06-02T01:31:00Z', 'visitor-boundary', 'web', 2000);
  `);

    await apply(db, migration("20260721_admin_traffic_page_view_rollup.sql"));
    await apply(db, migration("20260721_admin_traffic_dwell_rollup.sql"));
    await apply(db, migration("20260722_admin_telemetry_retention.sql"));
    await apply(db, migration("20260918_telemetry_retention_preview_scan.sql"));

    const allBefore = await previewFull(db);
    await apply(db, migration("20260925_telemetry_retention_kind_batches.sql"));
    assert.deepEqual(await previewFull(db), allBefore, "all-kind preview contract unchanged");
    const backup = `supabase-physical:1@${new Date().toISOString()}`;
    const batch = (execute = true, ref: string | null = backup) => db.query<{r: any}>(
      "SELECT admin_telemetry_retention_batch($1,$2) AS r", [execute,ref]);
    const rollups = (ref = backup) => db.query("SELECT admin_telemetry_retention_rollups($1)", [ref]);
    const count = (table: string) => scalar(db, `SELECT count(*) AS value FROM ${table}`);
    const rawBefore = await count("admin_page_views");
    const dwellBefore = await count("admin_page_dwell");
    await assert.rejects(batch(true, null), /backup reference/);
    await assert.rejects(batch(true, "supabase-physical:1@infinity"), /not fresh/);
    await assert.rejects(rollups(), /raw batches remain/);
    const pvPreview = (await batch(false)).rows[0].r;
    assert.equal(pvPreview.rawKind, "pageViews");
    assert.equal(pvPreview.preview.rawCandidates.pageViews, 3);
    assert.equal(pvPreview.preview.rawCandidates.pageDwell, 0,"PV preview excludes dwell");
    assert.equal(await count("admin_page_views"), rawBefore);
    // Corrupt only PV coverage: selected-kind validation must block deletion.
    await db.exec("BEGIN; UPDATE admin_traffic_daily_visitors SET pv=pv+1;");
    await assert.rejects(batch(), /coverage mismatch/);
    await db.exec("ROLLBACK;");
    assert.equal(await count("admin_page_views"), rawBefore);
    // Suppress one DELETE row: count gate rolls back the entire batch and audit.
    await db.exec(`CREATE FUNCTION qa_skip_raw() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.path='/qa/skip-delete' THEN RETURN NULL; END IF; RETURN OLD; END $$;
      CREATE TRIGGER qa_skip BEFORE DELETE ON admin_page_views FOR EACH ROW EXECUTE FUNCTION qa_skip_raw();`);
    await assert.rejects(batch(), /delete count mismatch/);
    assert.equal(await count("admin_page_views"), rawBefore);
    assert.equal(await count("admin_telemetry_retention_runs"), 0);
    await db.exec("DROP TRIGGER qa_skip ON admin_page_views;");
    const pv = (await batch()).rows[0].r;
    assert.equal(pv.rawKind, "pageViews");
    assert.equal(pv.deleted.pageViews, rawBefore - 1);
    assert.equal(await count("admin_page_views"), 1,"later eligible PV day survives first batch");
    assert.equal(pv.deleted.pageDwell, 0);
    assert.equal(await count("admin_page_dwell"), dwellBefore);
    await assert.rejects(rollups(), /raw batches remain/);
    // Balanced per-session corruption (same daily total/count) must still fail
    // after PV committed. A retry must select dwell, not re-delete PV.
    await db.exec(`BEGIN;
      UPDATE admin_dwell_session_slices x SET dwell_ms=CASE s.visitor_id
        WHEN 'visitor-b' THEN 9000 WHEN 'visitor-c' THEN 2000 ELSE x.dwell_ms END
      FROM admin_dwell_sessions s WHERE s.id=x.session_id;`);
    await assert.rejects(batch(), /coverage mismatch/);
    await db.exec("ROLLBACK;");
    assert.equal(await count("admin_telemetry_retention_runs"), 1);
    const dwPreview = (await batch(false)).rows[0].r;
    assert.equal(dwPreview.rawKind, "pageDwell");
    assert.equal(dwPreview.preview.rawCandidates.pageViews, 0,"dwell preview excludes PV");
    assert.equal(dwPreview.preview.rawCandidates.pageDwell, 4);
    const dw = (await batch()).rows[0].r;
    assert.equal(dw.rawKind, "pageDwell");
    assert.equal(dw.deleted.pageDwell, 4);
    assert.equal(dw.batchDay, "2026-06-01");
    assert.equal((await batch()).rows[0].r.deleted.pageDwell, 3);
    const laterPv = (await batch()).rows[0].r;
    assert.equal(laterPv.batchDay, "2026-06-03");
    assert.equal(laterPv.deleted.pageViews, 1);
    assert.equal((await batch()).rows[0].r.done, true);
    const beforeEmpty = await count("admin_telemetry_retention_runs");
    assert.equal((await batch()).rows[0].r.done, true);
    assert.equal(await count("admin_telemetry_retention_runs"), beforeEmpty);
    const auditsBeforeStale = await count("admin_telemetry_retention_runs");
    const rollupsBeforeStale = await count("admin_traffic_daily_visitors");
    await assert.rejects(rollups(`supabase-physical:1@${new Date(Date.now()-31*3600_000).toISOString()}`), /not fresh/);
    assert.equal(await count("admin_telemetry_retention_runs"), auditsBeforeStale);
    assert.equal(await count("admin_traffic_daily_visitors"), rollupsBeforeStale);
    await rollups();
    const phases = await db.query<{phase: string, raw_kind: string|null}>(
      "SELECT phase,raw_kind FROM admin_telemetry_retention_runs ORDER BY id");
    assert.deepEqual(phases.rows.map(r => r.phase), ["raw_batch","raw_batch","raw_batch","raw_batch","rollup_cleanup"]);
    assert.deepEqual(phases.rows.map(r => r.raw_kind), ["pageViews","pageDwell","pageDwell","pageViews",null]);
    // Fresh in-window raw must never be selected.
    await db.exec(`INSERT INTO admin_page_views(created_at,path,visitor_id,platform)
      VALUES (now(),'/home','in-window','web');`);
    assert.equal((await batch()).rows[0].r.done, true);
    assert.equal(await count("admin_page_views"), 1);
    for (const role of ["anon", "authenticated"]) {
      const grants = await db.query<{v:boolean}>(
        "SELECT has_function_privilege($1,'admin_telemetry_retention_batch(boolean,text)','EXECUTE') AS v",[role]);
      assert.equal(grants.rows[0].v,false);
    }
    console.log("PASS kind batches: unchanged preview, coverage/count rollback, resume, rollup barrier, audit phases, 30-day window, grants");
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
