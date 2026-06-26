import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminRequest } from "@/lib/admin/pin";
import { getKSTToday } from "@/lib/utils/date-kst";

type Row = { platform: string; date: string; units: number };

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const daysParam = Number(req.nextUrl.searchParams.get("days") ?? "30");
  const days = Math.min(Math.max(Number.isFinite(daysParam) ? daysParam : 30, 1), 365);
  // Calendar arithmetic on the KST date (anchor at 00:00 UTC so toISOString's
  // date stays aligned with the KST day; +09:00 midnight is the prior UTC day).
  const sinceDate = new Date(getKSTToday() + "T00:00:00Z");
  sinceDate.setUTCDate(sinceDate.getUTCDate() - (days - 1));
  const since = sinceDate.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("app_downloads")
    .select("platform,date,units")
    .gte("date", since)
    .order("date", { ascending: true });
  if (error) return supabaseErrorResponse(error);

  const rows = (data ?? []) as Row[];

  // Per-platform totals over the window + all-time cumulative.
  const totals: Record<string, number> = {};
  for (const r of rows) totals[r.platform] = (totals[r.platform] ?? 0) + Number(r.units);

  const { data: allData } = await supabase.from("app_downloads").select("platform,units");
  const cumulative: Record<string, number> = {};
  for (const r of (allData ?? []) as Row[]) {
    cumulative[r.platform] = (cumulative[r.platform] ?? 0) + Number(r.units);
  }

  return NextResponse.json({ since, days, rows, totals, cumulative });
}
