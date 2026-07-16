import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { startTokenEnvPatch } from "@/lib/notifications/live-activity-channel-policy";

// Live Activity W3b — push-to-start 토큰 등록/갱신.
// 클라가 앱 부팅 시 ActivityKit `pushToStartTokenUpdates`(iOS 17.2+)로 발급받은
// 디바이스 단위 토큰을 등록 → 최애팀 경기 시작 시 서버가 이 토큰으로 event:start 푸시.
// 로그인 필수. user_id 단위 upsert(디바이스당 1개 — 멀티 디바이스는 v1 비범위, 최신 1개).
export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified?.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // appBuild/osMajor(클라 명시 보고, 빌드 16+) — p2s input-push-channel 게이트 판정용
  // (os_major>=18 && app_build>=16, 미보고 null = 레거시 payload. 스펙 v4 blocker③).
  const { pushToStartToken, appBuild, osMajor } = await req.json();
  if (!pushToStartToken || typeof pushToStartToken !== "string") {
    return NextResponse.json({ error: "pushToStartToken required" }, { status: 400 });
  }
  const appBuildVal = Number.isInteger(appBuild) ? (appBuild as number) : null;
  const osMajorVal = Number.isInteger(osMajor) ? (osMajor as number) : null;

  // W3c 토글: "잠금화면 실시간 중계"를 끈 유저는 토큰을 저장하지 않는다(자동시작도 제외).
  // row 없음/null = 디폴트 on. 명시적으로 false일 때만 skip.
  const { data: prefRow } = await supabase
    .from("notification_prefs")
    .select("live_activity")
    .eq("user_id", verified.user.id)
    .maybeSingle();
  if (prefRow?.live_activity === false) {
    return NextResponse.json({ success: true, skipped: "live_activity_off" });
  }

  // 토큰은 디바이스 단위 — 같은 기기를 다른 계정이 쓰면(로그아웃→재로그인) 이전 유저 row에
  // 같은 토큰이 남아 register-device의 user_id 역매핑이 모호해진다(삼순 NO-GO). 이 토큰을
  // *현재 유저가 아닌* row에서 제거 → 토큰=최신 유저에 유일 귀속(DB unique 인덱스와 정합).
  const { error: cleanupErr } = await supabase
    .from("live_activity_start_tokens")
    .delete()
    .eq("push_to_start_token", pushToStartToken)
    .neq("user_id", verified.user.id);
  if (cleanupErr) return supabaseErrorResponse(cleanupErr);

  // 토큰 교체 감지 — apns_environment는 토큰 귀속이라 교체 시 null 리셋(삼순 #659 blocker③:
  // sandbox 잔존 env가 새 prod 토큰에 승계되면 per-attempt 규칙이 그 env로만 발송 →
  // BadDeviceToken → 유효한 새 토큰까지 삭제). 동일 토큰 재등록은 env 유지.
  const { data: existingRow, error: existErr } = await supabase
    .from("live_activity_start_tokens")
    .select("push_to_start_token")
    .eq("user_id", verified.user.id)
    .maybeSingle();
  if (existErr) return supabaseErrorResponse(existErr);

  const { error } = await supabase.from("live_activity_start_tokens").upsert(
    {
      user_id: verified.user.id,
      push_to_start_token: pushToStartToken,
      app_build: appBuildVal,
      os_major: osMajorVal,
      updated_at: new Date().toISOString(),
      ...startTokenEnvPatch(existingRow?.push_to_start_token ?? null, pushToStartToken),
    },
    { onConflict: "user_id" },
  );

  if (error) return supabaseErrorResponse(error);
  return NextResponse.json({ success: true });
}
