import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { getActiveNotices, sendNoticeToUser } from "@/lib/urgent-notice/send";

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

  // 삼순 NO-GO #3 — 신규 안드 토큰 등록 직후 활성 긴급공지 1인 1회 발송(서버측 트리거).
  // 플랫폼은 서버가 검증한 값(클라 body.platform 미신뢰). RPC가 (notice_key,user_id) unique
  // claim + active/target 게이트로 멱등·재시도 안전. 발송 실패해도 토큰 등록 응답은 성공(비차단).
  // 삼순 #1253 blocker② — 단, catch-up 실패는 cacheable:false로 클라에 알려 클라 dedupe
  // 캐시를 막는다(캐시되면 다음 부팅 재등록 = 공지 재시도 경로가 최대 24h 봉쇄되던 문제).
  let cacheable = true;
  try {
    const notices = await getActiveNotices(supabase, platform);
    for (const n of notices) await sendNoticeToUser(supabase, verified.user.id, n, platform);
  } catch (e) {
    cacheable = false;
    console.error("[register-device] urgent-notice failed:", (e as Error).message);
  }

  return NextResponse.json({ success: true, cacheable });
}
