import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminRequest } from "@/lib/admin/pin";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function verifyPin(req: NextRequest): boolean {
  return isAdminRequest(req);
}

export async function GET(req: NextRequest) {
  if (!verifyPin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobName = req.nextUrl.searchParams.get("job");
  const status = req.nextUrl.searchParams.get("status");
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "100");

  let query = supabase
    .from("admin_job_logs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);

  if (jobName) query = query.eq("job_name", jobName);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;

  if (error) return supabaseErrorResponse(error);

  return NextResponse.json({ data });
}
