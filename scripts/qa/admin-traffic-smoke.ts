/**
 * Admin traffic dwell-rollup contract smoke.
 *
 * The legacy RPC filters events at the KST reporting boundary, sessionizes by
 * visitor only, then splits each logical session by platform. The rollup must
 * keep those semantics for multi-platform visitors and boundary-crossing
 * sessions, including delayed beacons that bridge two existing sessions.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Event = {
  platform: string;
  visitor: string;
  at: number;
  day: number;
  dwellMs: number;
};

type Slice = { platform: string; day: number; dwellMs: number; events: number };
type Session = { visitor: string; start: number; end: number; slices: Map<string, Slice> };

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

function sliceKey(platform: string, day: number) {
  return `${platform}:${day}`;
}

function addSlice(target: Map<string, Slice>, slice: Slice) {
  const key = sliceKey(slice.platform, slice.day);
  const current = target.get(key);
  target.set(key, {
    ...slice,
    dwellMs: slice.dwellMs + (current?.dwellMs ?? 0),
    events: slice.events + (current?.events ?? 0),
  });
}

// Mirrors admin_page_dwell_track_session(): arrival order may differ from the
// event timestamp. Logical sessions are visitor-wide; platform/day are slices.
function rollup(events: Event[]): Session[] {
  const sessions: Session[] = [];
  for (const event of events) {
    const overlaps = sessions.filter(
      (session) =>
        session.visitor === event.visitor &&
        session.start <= event.at + GAP &&
        session.end >= event.at - GAP,
    );
    const eventSlice: Slice = {
      platform: event.platform,
      day: event.day,
      dwellMs: event.dwellMs,
      events: 1,
    };

    if (overlaps.length === 0) {
      sessions.push({
        visitor: event.visitor,
        start: event.at,
        end: event.at,
        slices: new Map([[sliceKey(event.platform, event.day), eventSlice]]),
      });
      continue;
    }

    const mergedSlices = new Map<string, Slice>();
    for (const session of overlaps) {
      for (const slice of session.slices.values()) addSlice(mergedSlices, slice);
    }
    addSlice(mergedSlices, eventSlice);

    const overlapSet = new Set(overlaps);
    for (let i = sessions.length - 1; i >= 0; i--) {
      if (overlapSet.has(sessions[i])) sessions.splice(i, 1);
    }
    sessions.push({
      visitor: event.visitor,
      start: Math.min(event.at, ...overlaps.map((session) => session.start)),
      end: Math.max(event.at, ...overlaps.map((session) => session.end)),
      slices: mergedSlices,
    });
  }
  return sessions;
}

function report(sessions: Session[], sinceDay: number) {
  const totals = new Map<string, number[]>();
  for (const session of sessions) {
    const byPlatform = new Map<string, number>();
    for (const slice of session.slices.values()) {
      if (slice.day < sinceDay) continue;
      byPlatform.set(
        slice.platform,
        (byPlatform.get(slice.platform) ?? 0) + slice.dwellMs,
      );
    }
    for (const [platform, dwellMs] of byPlatform) {
      const values = totals.get(platform) ?? [];
      values.push(dwellMs);
      totals.set(platform, values);
    }
  }
  return totals;
}

const minute = (n: number) => n * 60 * 1000;
const ev = (
  at: number,
  dwellMs = 1000,
  visitor = "v",
  platform = "ios_native",
  day = 0,
): Event => ({ at: minute(at), day, dwellMs, visitor, platform });

console.log("admin traffic dwell rollup");

{
  const rows = rollup([ev(0), ev(29), ev(60)]);
  check("29-minute gap merges, 31-minute gap splits", rows.length === 2);
  check(
    "merged session preserves dwell/event totals",
    rows.some((session) => {
      const slice = session.slices.get(sliceKey("ios_native", 0));
      return (
        session.start === minute(0) &&
        session.end === minute(29) &&
        slice?.dwellMs === 2000 &&
        slice.events === 2
      );
    }),
  );
}

{
  const rows = rollup([ev(0), ev(60), ev(30)]);
  const slice = rows[0].slices.get(sliceKey("ios_native", 0));
  check("delayed bridge event merges two sessions", rows.length === 1);
  check("bridge keeps full range", rows[0].start === minute(0) && rows[0].end === minute(60));
  check("bridge keeps every event once", slice?.events === 3 && slice.dwellMs === 3000);
}

{
  const rows = rollup([
    ev(0, 2000, "same-visitor", "ios_native"),
    ev(10, 3000, "same-visitor", "android_native"),
  ]);
  const totals = report(rows, 0);
  check("multi-platform visitor keeps one logical session", rows.length === 1);
  check(
    "one logical session keeps separate platform slices",
    totals.get("ios_native")?.[0] === 2000 &&
      totals.get("android_native")?.[0] === 3000,
  );
}

{
  const rows = rollup([
    ev(0, 7000, "midnight", "ios_native", 0),
    ev(10, 3000, "midnight", "ios_native", 1),
  ]);
  const laterWindow = report(rows, 1);
  check("cross-boundary events remain one logical session", rows.length === 1);
  check(
    "later window includes only later-day dwell",
    laterWindow.get("ios_native")?.length === 1 &&
      laterWindow.get("ios_native")?.[0] === 3000,
  );
}

const migration = readFileSync(
  resolve("supabase/migrations/20260721_admin_traffic_dwell_rollup.sql"),
  "utf8",
);
const pageViewMigration = readFileSync(
  resolve("supabase/migrations/20260721_admin_traffic_page_view_rollup.sql"),
  "utf8",
);
const route = readFileSync(resolve("src/app/api/admin/traffic/route.ts"), "utf8");
const page = readFileSync(resolve("src/app/admin/traffic/page.tsx"), "utf8");

check(
  "migration blocks inserts across backfill/trigger handoff",
  migration.includes("LOCK TABLE admin_page_dwell IN SHARE ROW EXCLUSIVE MODE"),
);
check(
  "migration serializes visitor-wide sessions",
  migration.includes("pg_advisory_xact_lock(hashtextextended(NEW.visitor_id, 0))"),
);
check(
  "trigger lookup does not partition by platform",
  /WHERE visitor_id = NEW\.visitor_id[\s\S]*AND session_start/.test(migration) &&
    !/WHERE platform = v_platform\s+AND visitor_id = NEW\.visitor_id/.test(migration),
);
check(
  "migration merges every overlapping logical session",
  /DELETE FROM admin_dwell_sessions[\s\S]*id <> v_session_id/.test(migration),
);
check(
  "dashboard aggregates per-day platform slices",
  /FUNCTION admin_dwell_by_platform[\s\S]*FROM admin_dwell_session_slices/.test(migration),
);
check(
  "dashboard filters slices at the KST reporting boundary",
  migration.includes("WHERE day_kst >= p_since") &&
    !/FUNCTION admin_dwell_by_platform[\s\S]*WHERE session_end >=/.test(migration),
);
check(
  "median keeps legacy floating-point tie rounding",
  migration.includes(
    "round(percentile_cont(0.5) WITHIN GROUP (ORDER BY session_ms)) AS median_ms",
  ) && !migration.includes("ORDER BY session_ms)::numeric"),
);
check(
  "dashboard slice range has a covering index",
  migration.includes("idx_admin_dwell_slices_day_covering"),
);
check(
  "page-view backfill and triggers share one writer lock",
  pageViewMigration.includes("LOCK TABLE admin_page_views IN SHARE ROW EXCLUSIVE MODE") &&
    pageViewMigration.includes("trg_admin_page_views_track_traffic_rollups"),
);
check(
  "daily and window totals read the compact visitor rollup",
  /FUNCTION admin_traffic_daily[\s\S]*FROM admin_traffic_daily_visitors/.test(
    pageViewMigration,
  ) &&
    /FUNCTION admin_traffic_totals[\s\S]*FROM admin_traffic_daily_visitors/.test(
      pageViewMigration,
    ),
);
check(
  "version share reads one latest row per native device",
  /FUNCTION admin_app_version_share[\s\S]*FROM admin_app_version_devices/.test(
    pageViewMigration,
  ),
);
check(
  "celebration telemetry stays excluded from both page-view rollups",
  (pageViewMigration.match(/NOT starts_with\([^\n]+, '\/_celeb'\)/g)?.length ?? 0) >= 3,
);
check(
  "out-of-order native events cannot replace a newer version",
  pageViewMigration.includes(
    "WHERE admin_app_version_devices.last_seen <= EXCLUDED.last_seen",
  ),
);
check("route no longer throws dwell RPC errors", !route.includes("if (dwell.error) throw dwell.error"));
check(
  "route exposes explicit dwell error status",
  route.includes('dwellStatus: dwell.error ? "error" : "ok"'),
);
check(
  "UI renders 조회 실패 instead of zero",
  page.includes('resp?.dwellStatus === "error"') && page.includes("조회 실패"),
);

console.log(`\n${pass}/${pass + fail} PASS`);
if (fail > 0) process.exit(1);
