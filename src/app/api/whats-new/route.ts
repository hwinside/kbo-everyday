import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const revalidate = 3600; // 1h ISR cache

export async function GET() {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("announcements")
    .select("id, title, summary, body, cta_label, cta_path, published_at")
    .eq("is_active", true)
    .or(`display_until.is.null,display_until.gt.${now}`)
    .order("published_at", { ascending: false })
    .limit(20);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? [], {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=600" },
  });
}
