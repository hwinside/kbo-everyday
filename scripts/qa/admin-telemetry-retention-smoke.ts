import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  physicalBackupRef,
  selectFreshPhysicalBackup,
} from "../../src/lib/admin/telemetry-retention";

const now = Date.parse("2026-07-22T00:00:00Z");
const fresh = selectFreshPhysicalBackup([
  { id: 1, inserted_at: "2026-07-21T20:00:00Z", status: "FAILED", is_physical_backup: true },
  { id: 2, inserted_at: "2026-07-21T21:00:00Z", status: "COMPLETED", is_physical_backup: false },
  { id: 3, inserted_at: "2026-07-20T10:00:00Z", status: "COMPLETED", is_physical_backup: true },
  { id: 4, inserted_at: "2026-07-21T22:00:00Z", status: "COMPLETED", is_physical_backup: true },
], now);
assert.deepEqual(fresh, { id: 4, inserted_at: "2026-07-21T22:00:00Z" });
assert.equal(physicalBackupRef(fresh!), "supabase-physical:4@2026-07-21T22:00:00Z");
assert.equal(selectFreshPhysicalBackup([
  { id: 5, inserted_at: "2026-07-20T10:00:00Z", status: "COMPLETED", is_physical_backup: true },
], now), null, "backup older than 30h must fail closed");

const migration = readFileSync(
  resolve("supabase/migrations/20260722_admin_telemetry_retention.sql"),
  "utf8",
);
for (const contract of [
  "v_today_kst - 30",
  "v_today_kst - 365",
  "admin_page_view_user_days",
  "coverageMismatches",
  "LOCK TABLE admin_page_views, admin_page_dwell",
  "fresh physical backup reference required",
  "physical backup is not fresh",
  "raw-to-rollup coverage mismatch",
  "raw delete count mismatch",
  "sum(dwell_ms)::bigint AS dwell_ms",
  "rolled.game_ids <@ raw.game_ids",
  "FULL JOIN rolled_daily",
  "FULL JOIN rolled_user_days",
  "rolled.dwell_ms IS DISTINCT FROM raw.dwell_ms",
  "pageDwellSessions",
  "pageDwellDistribution",
  "created_at - previous_at > interval '30 minutes'",
  "PARTITION BY visitor_id",
  "FULL JOIN rolled_session_slices",
  "USING (visitor_id, session_no, platform, day_kst)",
  "admin_telemetry_retention_runs",
  "REVOKE EXECUTE ON FUNCTION admin_telemetry_retention_run",
]) {
  assert(migration.includes(contract), `migration contract missing: ${contract}`);
}

const dryRunIndex = migration.indexOf("IF NOT p_execute THEN");
const deleteIndex = migration.indexOf("DELETE FROM admin_page_views WHERE created_at < v_raw_cutoff");
assert(dryRunIndex >= 0 && dryRunIndex < deleteIndex, "dry-run must return before raw DELETE");

const vercel = JSON.parse(readFileSync(resolve("vercel.json"), "utf8")) as {
  crons: Array<{ path: string; schedule: string }>;
};
assert(vercel.crons.some((cron) =>
  cron.path === "/api/cron/admin-telemetry-retention" && cron.schedule === "30 22 * * *"
));

console.log("PASS admin telemetry retention: backup freshness, dry-run, coverage, count, audit and schedule gates");
