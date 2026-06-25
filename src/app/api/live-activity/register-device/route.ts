import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";

// Live Activity W3a — per-activity update token 등록 (디바이스 토큰 인증, 백그라운드용).
//
// /register는 WebView(JS)가 인증 세션으로 호출한다. 그런데 push-to-start로 앱이 닫힌 채
// 뜬 카드는 WebView JS가 안 떠 있어 update token이 서버에 등록되지 않고, 카드가 시작
// 스냅샷에 얼어붙는다(앱을 한 번 열기 전까지). 이 엔드포인트는 네이티브가 *앱 포그라운드
// 없이* update token을 등록할 수 있게 한다 — 유저 세션 대신 디바이스의 push-to-start
// 토큰을 신원 증명으로 써서 user_id를 역매핑한다(그 토큰은 이미 register-start로 등록됨).
export async function POST(req: NextRequest) {
  const { gameId, pushToken, pushToStartToken } = await req.json();
  if (
    !gameId || typeof gameId !== "string" ||
    !pushToken || typeof pushToken !== "string" ||
    !pushToStartToken || typeof pushToStartToken !== "string"
  ) {
    return NextResponse.json(
      { error: "gameId, pushToken, pushToStartToken required" },
      { status: 400 },
    );
  }

  // 디바이스 신원 = push-to-start 토큰(register-start로 이미 등록된 유저-디바이스 매핑).
  // 이 토큰을 아는 주체 = 그 디바이스 + 서버뿐 → user_id 역매핑의 증명으로 사용.
  const { data: owner, error: lookupErr } = await supabase
    .from("live_activity_start_tokens")
    .select("user_id")
    .eq("push_to_start_token", pushToStartToken)
    .maybeSingle();
  if (lookupErr) return supabaseErrorResponse(lookupErr);
  if (!owner?.user_id) {
    // 미등록 토큰 → 등록 대상 불명. 조용히 skip(네이티브는 결과 무시, 앱 영향 없음).
    return NextResponse.json({ success: true, skipped: "unknown_start_token" });
  }

  // W3c 토글: "잠금화면 실시간 중계"를 끈 유저는 update token을 저장하지 않는다.
  // row 없음/null = 디폴트 on. 명시적으로 false일 때만 skip(/register와 동일 게이트).
  const { data: prefRow } = await supabase
    .from("notification_prefs")
    .select("live_activity")
    .eq("user_id", owner.user_id)
    .maybeSingle();
  if (prefRow?.live_activity === false) {
    return NextResponse.json({ success: true, skipped: "live_activity_off" });
  }

  const { error } = await supabase.from("live_activity_tokens").upsert(
    {
      user_id: owner.user_id,
      game_id: gameId,
      push_token: pushToken,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,game_id" },
  );

  if (error) return supabaseErrorResponse(error);
  return NextResponse.json({ success: true });
}
