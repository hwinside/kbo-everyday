import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";

// 네이티브 앱(iOS/Android) FCM 디바이스 토큰 등록/갱신.
// 웹 Web Push는 별도(/api/push/subscribe). 로그인 필수.
export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified?.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { fcmToken, platform } = await req.json();
  if (!fcmToken || (platform !== "ios" && platform !== "android")) {
    return NextResponse.json({ error: "fcmToken and platform(ios|android) required" }, { status: 400 });
  }

  const { error } = await supabase.from("device_push_tokens").upsert({
    user_id: verified.user.id,
    platform,
    fcm_token: fcmToken,
    last_seen: new Date().toISOString(),
  }, { onConflict: "fcm_token" });

  if (error) return supabaseErrorResponse(error);
  return NextResponse.json({ success: true });
}
