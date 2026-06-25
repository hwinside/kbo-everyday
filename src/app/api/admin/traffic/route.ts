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

  const days = Math.min(Math.max(Number(req.nextUrl.searchParams.get("days") ?? "7"), 1), 90);
  const todayKST = getKSTToday();
  const sinceDate = new Date(
    new Date(todayKST + "T00:00:00+09:00").getTime() - (days - 1) * 86400000,
  );
  const since = sinceDate.toISOString().slice(0, 10);

  const { data, error } = await supabase.rpc("admin_traffic_daily", { p_since: since });
  if (error) return supabaseErrorResponse(error);

  const rows = (data ?? []) as TrafficRow[];

  // Per-platform totals over the window
  const totals: Record<string, { pv: number; uv: number }> = {};
  for (const r of rows) {
    const t = (totals[r.platform] ??= { pv: 0, uv: 0 });
    t.pv += Number(r.pv);
    t.uv += Number(r.uv);
  }

  return NextResponse.json({ since, days, rows, totals });
}
