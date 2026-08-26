import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { requireAdmin } from "@/lib/admin/pin";
import { getKSTToday } from "@/lib/utils/date-kst";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const days = Number(req.nextUrl.searchParams.get("days") ?? "30");
  const todayKST = getKSTToday();
  const sinceDate = new Date(new Date(todayKST + "T00:00:00+09:00").getTime() - days * 86400000);
  const since = sinceDate.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("admin_daily_stats")
    .select("*")
    .gte("date", since)
    .order("date", { ascending: true });

  if (error) return supabaseErrorResponse(error);

  return NextResponse.json({ data });
}
