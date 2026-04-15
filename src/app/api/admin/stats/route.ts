import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminRequest } from "@/lib/admin/pin";
import { getKSTToday } from "@/lib/utils/date-kst";

function verifyPin(req: NextRequest): boolean {
  return isAdminRequest(req);
}

export async function GET(req: NextRequest) {
  if (!verifyPin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
