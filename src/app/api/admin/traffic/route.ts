import { NextRequest, NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminAuthedRequest } from "@/lib/admin/pin";
import { getKSTToday } from "@/lib/utils/date-kst";

type TrafficRow = { day: string; platform: string; pv: number; uv: number };

type TrafficPayload = {
  since: string;
  days: number;
  rows: TrafficRow[];
  totals: Record<string, { pv: number; uv: number }>;
  devices: Record<string, number>;
  dwell: Record<string, { sessions: number; avgMs: number; medianMs: number }>;
  dwellStatus: "ok" | "error";
  versions: Record<string, { version: string; devices: number }[]>;
};

async function loadTraffic(days: number): Promise<TrafficPayload> {
  // Calendar arithmetic on the KST date (anchor at 00:00 UTC so toISOString's
  // date stays aligned with the KST day; +09:00 midnight is the prior UTC day).
  const sinceDate = new Date(getKSTToday() + "T00:00:00Z");
  sinceDate.setUTCDate(sinceDate.getUTCDate() - (days - 1));
  const since = sinceDate.toISOString().slice(0, 10);

  // Daily rows feed the per-day chart; totals give true window-DISTINCT UV
  // (summing daily uv would double-count multi-day visitors). appDevices is the
  // all-time DISTINCT visitor_id from native shells (unique app devices).
  const [daily, windowTotals, appDevices, dwell, versions] = await Promise.all([
    supabase.rpc("admin_traffic_daily", { p_since: since }),
    supabase.rpc("admin_traffic_totals", { p_since: since }),
    supabase.rpc("admin_app_device_totals"),
    supabase.rpc("admin_dwell_by_platform", { p_since: since }),
    supabase.rpc("admin_app_version_share", { p_since: since }),
  ]);
  if (daily.error) throw daily.error;
  if (windowTotals.error) throw windowTotals.error;
  if (appDevices.error) throw appDevices.error;
  if (versions.error) throw versions.error;

  const rows = (daily.data ?? []) as TrafficRow[];
  const totalsRows = (windowTotals.data ?? []) as Omit<TrafficRow, "day">[];

  const totals: Record<string, { pv: number; uv: number }> = {};
  for (const r of totalsRows) {
    totals[r.platform] = { pv: Number(r.pv), uv: Number(r.uv) };
  }

  const devices: Record<string, number> = {};
  for (const r of (appDevices.data ?? []) as { platform: string; devices: number }[]) {
    devices[r.platform] = Number(r.devices);
  }

  // Per-platform session dwell (active time-on-site). avg is skewed high by
  // idle-but-visible tails, so the UI leans on median.
  const dwellByPlatform: Record<
    string,
    { sessions: number; avgMs: number; medianMs: number }
  > = {};
  for (const r of (dwell.data ?? []) as {
    platform: string;
    sessions: number;
    avg_ms: number;
    median_ms: number;
  }[]) {
    dwellByPlatform[r.platform] = {
      sessions: Number(r.sessions),
      avgMs: Number(r.avg_ms),
      medianMs: Number(r.median_ms),
    };
  }

  // App version share per native platform (active distinct devices per version).
  // Forward-only: rows without app_version roll up as '미상'.
  const versionShare: Record<string, { version: string; devices: number }[]> = {};
  for (const r of (versions.data ?? []) as {
    platform: string;
    app_version: string;
    devices: number;
  }[]) {
    (versionShare[r.platform] ??= []).push({
      version: r.app_version,
      devices: Number(r.devices),
    });
  }

  return {
    since,
    days,
    rows,
    totals,
    devices,
    dwell: dwellByPlatform,
    // Dwell is an optional card. A timeout must not erase otherwise valid
    // PV/UV/device/version data or turn the whole dashboard into an API 500.
    dwellStatus: dwell.error ? "error" : "ok",
    versions: versionShare,
  };
}

// Per-instance TTL cache with in-flight coalescing. Each dashboard load (and
// every 오늘/7일/30일 toggle) fires 5 aggregate RPCs at once; on prod they
// average 0.4~1.6s each with spikes to 6~8s that trip the 8s statement
// timeout (the intermittent 500s). 60s staleness is fine for an admin
// dashboard, and sharing the in-flight promise stops concurrent requests from
// stampeding the DB. Failed loads are evicted so errors are never cached.
const CACHE_TTL_MS = 60_000;
const cache = new Map<number, { at: number; promise: Promise<TrafficPayload> }>();

export async function GET(req: NextRequest) {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const daysParam = Number(req.nextUrl.searchParams.get("days") ?? "7");
  const days = Math.min(Math.max(Number.isFinite(daysParam) ? daysParam : 7, 1), 90);

  const now = Date.now();
  let entry = cache.get(days);
  if (!entry || now - entry.at > CACHE_TTL_MS) {
    const fresh = { at: now, promise: loadTraffic(days) };
    fresh.promise.catch(() => {
      if (cache.get(days) === fresh) cache.delete(days);
    });
    cache.set(days, fresh);
    entry = fresh;
  }

  try {
    const payload = await entry.promise;
    // Let the browser reuse the response across period toggles/reloads for 60s.
    // Vary on the auth inputs so a logged-out tab can't read a cached copy:
    // x-admin-pin today, and Cookie for when the admin session moves to an
    // HttpOnly cookie (PR #681) — the header carries no PIN then.
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "private, max-age=60",
        Vary: "Cookie, x-admin-pin",
      },
    });
  } catch (e) {
    return supabaseErrorResponse(e as PostgrestError);
  }
}
