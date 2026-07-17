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

  const { fcmToken, platform, appBuild } = await req.json();
  if (!fcmToken || (platform !== "ios" && platform !== "android")) {
    return NextResponse.json({ error: "fcmToken and platform(ios|android) required" }, { status: 400 });
  }

  // 앱 빌드 번호(선택) — 빌드 게이트 필터용(예: widget_live는 iOS build 17+만, 삼순 #674
  // blocker⑤). 미보고/비정상값은 null = 구버전 취급(fail-closed).
  const buildNum = Number.isFinite(Number(appBuild)) && Number(appBuild) > 0
    ? Math.trunc(Number(appBuild))
    : null;

  const { error } = await supabase.from("device_push_tokens").upsert({
    user_id: verified.user.id,
    platform,
    fcm_token: fcmToken,
    app_build: buildNum,
    last_seen: new Date().toISOString(),
  }, { onConflict: "fcm_token" });

  if (error) return supabaseErrorResponse(error);
  return NextResponse.json({ success: true });
}
