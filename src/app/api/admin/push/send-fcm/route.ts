import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminAuthedRequest } from "@/lib/admin/pin";
import { sendFcmToUsers, getFcm } from "@/lib/notifications/fcm";

// 어드민 수동 FCM 푸시 발송 — 공용 헬퍼(src/lib/notifications/fcm.ts) 사용.
// prefs 필터 없음 (어드민 수동 발송은 전체/지정 대상에 그대로)

export async function POST(req: NextRequest) {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!getFcm()) {
    return NextResponse.json({ error: "FIREBASE_SERVICE_ACCOUNT not configured" }, { status: 500 });
  }

  const { title, body, url, userIds } = await req.json();
  if (!title || !body) {
    return NextResponse.json({ error: "title and body required" }, { status: 400 });
  }

  let targetIds: string[] = userIds ?? [];
  if (targetIds.length === 0) {
    const { data, error } = await supabase.from("device_push_tokens").select("user_id");
    if (error) return supabaseErrorResponse(error);
    targetIds = [...new Set((data ?? []).map((r: { user_id: string }) => r.user_id))];
  }

  const res = await sendFcmToUsers(targetIds, { title, body, url });
  return NextResponse.json(res);
}
