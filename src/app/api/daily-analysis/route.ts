import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function GET(req: NextRequest) {
  const dateParam = req.nextUrl.searchParams.get("date");

  let isoDate: string;
  if (dateParam && /^\d{8}$/.test(dateParam)) {
    isoDate = `${dateParam.slice(0, 4)}-${dateParam.slice(4, 6)}-${dateParam.slice(6, 8)}`;
  } else {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    isoDate = kst.toISOString().slice(0, 10);
  }

  const { data, error } = await supabaseAdmin
    .from("daily_analysis")
    .select("type, delta_json, generated_copy, prompt_version, created_at")
    .eq("date", isoDate);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const result: Record<string, { copy: string | null; delta: unknown; prompt_version: number; created_at: string }> = {};
  for (const row of data ?? []) {
    result[row.type] = {
      copy: row.generated_copy,
      delta: row.delta_json,
      prompt_version: row.prompt_version,
      created_at: row.created_at,
    };
  }

  return NextResponse.json(
    { date: isoDate, analysis: result },
    { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=600" } },
  );
}
