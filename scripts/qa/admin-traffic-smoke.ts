/**
 * Admin traffic dwell-rollup contract smoke.
 *
 * Verifies the SQL keeps one session for <=30-minute gaps (including delayed
 * beacons that bridge two sessions), and the route/UI fail visibly without
 * converting a dwell timeout into a whole-dashboard 500 or fake zero.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Event = {
  platform: string;
  visitor: string;
  at: number;
  dwellMs: number;
};

type Session = Event & { start: number; end: number; events: number };

const GAP = 30 * 60 * 1000;
let pass = 0;
let fail = 0;

function check(name: string, ok: boolean) {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

// Mirrors admin_page_dwell_track_session(): arrival order may differ from the
// event timestamp, and one delayed event may merge two existing sessions.
function rollup(events: Event[]): Session[] {
  const sessions: Session[] = [];
  for (const event of events) {
    const overlaps = sessions.filter(
      (s) =>
        s.platform === event.platform &&
        s.visitor === event.visitor &&
        s.start <= event.at + GAP &&
        s.end >= event.at - GAP,
    );
    if (overlaps.length === 0) {
      sessions.push({ ...event, start: event.at, end: event.at, events: 1 });
      continue;
    }
    const ids = new Set(overlaps);
    const merged: Session = {
      ...event,
      start: Math.min(event.at, ...overlaps.map((s) => s.start)),
      end: Math.max(event.at, ...overlaps.map((s) => s.end)),
      dwellMs: event.dwellMs + overlaps.reduce((sum, s) => sum + s.dwellMs, 0),
      events: 1 + overlaps.reduce((sum, s) => sum + s.events, 0),
    };
    for (let i = sessions.length - 1; i >= 0; i--) {
      if (ids.has(sessions[i])) sessions.splice(i, 1);
    }
    sessions.push(merged);
  }
  return sessions;
}

const minute = (n: number) => n * 60 * 1000;
const ev = (at: number, dwellMs = 1000, visitor = "v", platform = "ios_native"): Event => ({
  at: minute(at),
  dwellMs,
  visitor,
  platform,
});

console.log("admin traffic dwell rollup");

{
  const rows = rollup([ev(0), ev(29), ev(60)]);
  check("29-minute gap merges, 31-minute gap splits", rows.length === 2);
  check(
    "merged session preserves dwell/event totals",
    rows.some((s) => s.start === minute(0) && s.end === minute(29) && s.dwellMs === 2000 && s.events === 2),
  );
}

{
  const rows = rollup([ev(0), ev(60), ev(30)]);
  check("delayed bridge event merges two sessions", rows.length === 1);
  check("bridge keeps full range", rows[0].start === minute(0) && rows[0].end === minute(60));
  check("bridge keeps every event once", rows[0].events === 3 && rows[0].dwellMs === 3000);
}

{
  const rows = rollup([
    ev(50, 2000, "a", "ios_native"),
    ev(10, 3000, "b", "ios_native"),
    ev(20, 4000, "a", "android_native"),
  ]);
  check("visitor/platform pairs remain isolated", rows.length === 3);
}

const migration = readFileSync(
  resolve("supabase/migrations/20260721_admin_traffic_dwell_rollup.sql"),
  "utf8",
);
const route = readFileSync(resolve("src/app/api/admin/traffic/route.ts"), "utf8");
const page = readFileSync(resolve("src/app/admin/traffic/page.tsx"), "utf8");

check("migration blocks inserts across backfill/trigger handoff", migration.includes("LOCK TABLE admin_page_dwell IN SHARE ROW EXCLUSIVE MODE"));
check("migration serializes each visitor/platform", migration.includes("pg_advisory_xact_lock"));
check("migration merges every overlapping session", migration.includes("DELETE FROM admin_dwell_sessions WHERE id = ANY(v_ids)"));
check("dashboard RPC reads rollup table", /FUNCTION admin_dwell_by_platform[\s\S]*FROM admin_dwell_sessions/.test(migration));
check("dashboard range has covering index", migration.includes("idx_admin_dwell_sessions_end_covering"));
check("route no longer throws dwell RPC errors", !route.includes("if (dwell.error) throw dwell.error"));
check("route exposes explicit dwell error status", route.includes('dwellStatus: dwell.error ? "error" : "ok"'));
check("UI renders 조회 실패 instead of zero", page.includes('resp?.dwellStatus === "error"') && page.includes("조회 실패"));

console.log(`\n${pass}/${pass + fail} PASS`);
if (fail > 0) process.exit(1);
