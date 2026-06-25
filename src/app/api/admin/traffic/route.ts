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
  const todayKST = getKSTToday();
  const sinceDate = new Date(
    new Date(todayKST + "T00:00:00+09:00").getTime() - (days - 1) * 86400000,
  );
  const since = sinceDate.toISOString().slice(0, 10);

  // Daily rows feed the per-day chart; totals give true window-DISTINCT UV
  // (summing daily uv would double-count multi-day visitors).
  const [daily, windowTotals] = await Promise.all([
    supabase.rpc("admin_traffic_daily", { p_since: since }),
    supabase.rpc("admin_traffic_totals", { p_since: since }),
  ]);
  if (daily.error) return supabaseErrorResponse(daily.error);
  if (windowTotals.error) return supabaseErrorResponse(windowTotals.error);

  const rows = (daily.data ?? []) as TrafficRow[];
  const totalsRows = (windowTotals.data ?? []) as Omit<TrafficRow, "day">[];

  const totals: Record<string, { pv: number; uv: number }> = {};
  for (const r of totalsRows) {
    totals[r.platform] = { pv: Number(r.pv), uv: Number(r.uv) };
  }

  return NextResponse.json({ since, days, rows, totals });
}
