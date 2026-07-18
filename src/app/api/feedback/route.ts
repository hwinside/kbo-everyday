import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { sendAdminPush } from "@/lib/admin/push";

const VALID_TYPES = ["bug", "data", "feature", "content", "other", "android_test"];

export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const { type, title, body, pageUrl, deviceInfo } = await req.json();

  if (!title?.trim()) {
    return NextResponse.json({ error: "필수 값 누락" }, { status: 400 });
  }

  if (!VALID_TYPES.includes(type)) {
    return NextResponse.json({ error: "유효하지 않은 유형입니다" }, { status: 400 });
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { count, error: countError } = await supabase
    .from("feedback")
    .select("*", { count: "exact", head: true })
    .eq("user_id", verified.user.id)
    .gte("created_at", todayStart.toISOString());

  if (countError) return supabaseErrorResponse(countError);

  if ((count ?? 0) >= 10) {
    return NextResponse.json({ error: "하루 최대 10건까지 보낼 수 있어요" }, { status: 429 });
  }

  const { error } = await supabase.from("feedback").insert({
    user_id: verified.user.id,
    type,
    title: title.trim(),
    body: body || null,
    page_url: pageUrl || null,
    device_info: deviceInfo || null,
  });

  if (error) return supabaseErrorResponse(error);

  // 어드민 PWA 알림 (best-effort — 실패해도 건의 접수에는 영향 없음, 2026-07-18)
  try {
    await sendAdminPush({
      title: "새 건의 도착",
      body: `[${type}] ${title.trim().slice(0, 80)}`,
      url: "/admin/feedback",
      tag: "admin-feedback",
    });
  } catch {
    /* ignore */
  }

  return NextResponse.json({ success: true });
}
