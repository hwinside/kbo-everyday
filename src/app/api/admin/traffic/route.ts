import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminRequest } from "@/lib/admin/pin";
import { getKSTToday } from "@/lib/utils/date-kst";

type TrafficRow = { day: string; platform: string; pv: number; uv: number };

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const daysParam = Number(req.nextUrl.searchParams.get("days") ?? "7");
  const days = Math.min(Math.max(Number.isFinite(daysParam) ? daysParam : 7, 1), 90);
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
  if (daily.error) return supabaseErrorResponse(daily.error);
  if (windowTotals.error) return supabaseErrorResponse(windowTotals.error);
  if (appDevices.error) return supabaseErrorResponse(appDevices.error);
  if (dwell.error) return supabaseErrorResponse(dwell.error);
  if (versions.error) return supabaseErrorResponse(versions.error);

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

  return NextResponse.json({
    since,
    days,
    rows,
    totals,
    devices,
    dwell: dwellByPlatform,
    versions: versionShare,
  });
}
