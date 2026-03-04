import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const VALID_TYPES = ["bug", "data", "feature", "content", "other"];

export async function POST(req: NextRequest) {
  const { userId, type, title, body, pageUrl, deviceInfo } = await req.json();

  if (!userId || !title?.trim()) {
    return NextResponse.json({ error: "필수 값 누락" }, { status: 400 });
  }

  if (!VALID_TYPES.includes(type)) {
    return NextResponse.json({ error: "유효하지 않은 유형입니다" }, { status: 400 });
  }

  // Rate limit: 10 per day per user
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { count, error: countError } = await supabase
    .from("feedback")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", todayStart.toISOString());

  if (countError) {
    return NextResponse.json({ error: countError.message }, { status: 500 });
  }

  if ((count ?? 0) >= 10) {
    return NextResponse.json({ error: "하루 최대 10건까지 보낼 수 있어요" }, { status: 429 });
  }

  const { error } = await supabase.from("feedback").insert({
    user_id: userId,
    type,
    title: title.trim(),
    body: body || null,
    page_url: pageUrl || null,
    device_info: deviceInfo || null,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
