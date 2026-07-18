import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminAuthedRequest } from "@/lib/admin/pin";

// 어드민 PWA 웹푸시 구독 등록 — PIN 인증 기기만 (2026-07-18).
// 유저용 /api/push/subscribe와 별도 테이블(admin_push_subscriptions)에 저장한다.
export async function POST(req: NextRequest) {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { subscription } = await req.json();
  if (!subscription?.endpoint) {
    return NextResponse.json({ error: "subscription required" }, { status: 400 });
  }

  const { error } = await supabase.from("admin_push_subscriptions").upsert(
    {
      endpoint: subscription.endpoint,
      subscription,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "endpoint" },
  );

  if (error) return supabaseErrorResponse(error);
  return NextResponse.json({ success: true });
}

// 알림 끄기 — 서버측 구독 행 삭제 (2026-07-18 2차 리뷰 P2: 클라 DELETE 호출에 맞는 실구현)
export async function DELETE(req: NextRequest) {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { endpoint } = await req.json().catch(() => ({}));
  if (!endpoint || typeof endpoint !== "string") {
    return NextResponse.json({ error: "endpoint required" }, { status: 400 });
  }
  const { error } = await supabase.from("admin_push_subscriptions").delete().eq("endpoint", endpoint);
  if (error) return supabaseErrorResponse(error);
  return NextResponse.json({ success: true });
}
