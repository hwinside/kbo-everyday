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

  const { gameId, pushToken } = await req.json();
  if (!gameId || !pushToken || typeof gameId !== "string" || typeof pushToken !== "string") {
    return NextResponse.json({ error: "gameId and pushToken required" }, { status: 400 });
  }

  const { error } = await supabase.from("live_activity_tokens").upsert(
    {
      user_id: verified.user.id,
      game_id: gameId,
      push_token: pushToken,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,game_id" },
  );

  if (error) return supabaseErrorResponse(error);
  return NextResponse.json({ success: true });
}
