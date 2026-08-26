import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { requireAdmin } from "@/lib/admin/pin";
import { getKSTTodayStart } from "@/lib/utils/date-kst";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const jobName = req.nextUrl.searchParams.get("job");
  const status = req.nextUrl.searchParams.get("status");
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "100");
  const todayOnly = req.nextUrl.searchParams.get("today") === "1";

  let query = supabase
    .from("admin_job_logs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);

  if (jobName) query = query.eq("job_name", jobName);
  if (status) query = query.eq("status", status);
  if (todayOnly) query = query.gte("started_at", getKSTTodayStart());

  const { data, error } = await query;

  if (error) return supabaseErrorResponse(error);

  return NextResponse.json({ data });
}
