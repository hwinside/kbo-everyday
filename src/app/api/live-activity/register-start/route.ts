import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";

// Live Activity W3b — push-to-start 토큰 등록/갱신.
// 클라가 앱 부팅 시 ActivityKit `pushToStartTokenUpdates`(iOS 17.2+)로 발급받은
// 디바이스 단위 토큰을 등록 → 최애팀 경기 시작 시 서버가 이 토큰으로 event:start 푸시.
// 로그인 필수. user_id 단위 upsert(디바이스당 1개 — 멀티 디바이스는 v1 비범위, 최신 1개).
export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified?.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { pushToStartToken } = await req.json();
  if (!pushToStartToken || typeof pushToStartToken !== "string") {
    return NextResponse.json({ error: "pushToStartToken required" }, { status: 400 });
  }

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

  // 새 기기/재설치 감지 — 이전 토큰과 다른 토큰이 등록되면(앱 재설치 = 새 push-to-start
  // 토큰) 이 유저의 자동시작 선점 기록을 비워, 진행 중인 경기에 대해 새 카드를 다시 받게 한다.
  // (선점은 중복 발송 dedup용일 뿐 — 지운 뒤에도 alreadyActive[활성 카드 토큰]가 중복을 막는다.
  //  같은 기기 재부팅은 토큰이 동일 → 아무것도 지우지 않으므로 정상 세션엔 영향 없음.)
  const { data: prevRow } = await supabase
    .from("live_activity_start_tokens")
    .select("push_to_start_token")
    .eq("user_id", verified.user.id)
    .maybeSingle();
  const isFreshDevice = prevRow?.push_to_start_token !== pushToStartToken;

  const { error } = await supabase.from("live_activity_start_tokens").upsert(
    {
      user_id: verified.user.id,
      push_to_start_token: pushToStartToken,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) return supabaseErrorResponse(error);

  if (isFreshDevice) {
    await supabase
      .from("live_activity_started_users")
      .delete()
      .eq("user_id", verified.user.id);
  }

  return NextResponse.json({ success: true });
}
