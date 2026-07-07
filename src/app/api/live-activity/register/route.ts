import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";

// Live Activity W3a — per-activity APNs push token 등록/갱신.
// 클라가 경기룸 진입으로 Activity를 띄우면 ActivityKit이 push token을 발급 → 등록.
// warmup cron이 스코어 변화 시 이 토큰들로 APNs liveactivity 업데이트를 보낸다.
// 로그인 필수. (user_id, game_id) 단위 upsert — 한 유저-경기당 최신 토큰 1개.
export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified?.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { gameId, pushToken, appBuild } = await req.json();
  if (!gameId || !pushToken || typeof gameId !== "string" || typeof pushToken !== "string") {
    return NextResponse.json({ error: "gameId and pushToken required" }, { status: 400 });
  }
  // 앱 빌드 번호(선택) — 서버가 빌드별로 LA payload를 분기(풀/슬림)하기 위한 태그.
  // 숫자 아닌 값/누락은 null(=슬림)로 안전 폴백.
  const build = typeof appBuild === "number" && Number.isFinite(appBuild) ? Math.floor(appBuild) : null;

  // W3c 토글: "잠금화면 실시간 중계"를 끈 유저는 토큰을 저장하지 않는다(스펙: 클라/서버
  // 둘 다 off 유저 제외). row 없음/null = 디폴트 on. 명시적으로 false일 때만 skip.
  const { data: prefRow } = await supabase
    .from("notification_prefs")
    .select("live_activity")
    .eq("user_id", verified.user.id)
    .maybeSingle();
  if (prefRow?.live_activity === false) {
    return NextResponse.json({ success: true, skipped: "live_activity_off" });
  }

  const { error } = await supabase.from("live_activity_tokens").upsert(
    {
      user_id: verified.user.id,
      game_id: gameId,
      push_token: pushToken,
      app_build: build,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,game_id" },
  );

  if (error) return supabaseErrorResponse(error);
  return NextResponse.json({ success: true });
}
