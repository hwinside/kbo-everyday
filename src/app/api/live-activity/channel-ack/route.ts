import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";

// 채널 구독 ACK (스펙 v4 §서버 4) — 네이티브가 `.channel` activity 생성/감지를 확인했을 때만
// 호출하는 구독 SSOT 기록. APNs 200 기반 서버측 추정 마킹은 하지 않는다.
//
// 인증(device-auth): 로그인 세션이 없을 수 있으므로(p2s로 뜬 카드) 그 기기의
// pushToStartToken을 인증자로 받는다 — live_activity_start_tokens에 실존해야 수락(위조 차단).
// device_key는 클라 입력을 신뢰하지 않고 *서버가 검증된 토큰에서 derive*한다(조건부 GO 정정①).
//
// 4xx 계약(클라 재시도 정책과 짝): stale channel/invalid token = 4xx → 클라는 폐기(TTL),
// 재시도는 network/5xx만.
export async function POST(req: NextRequest) {
  let body: {
    gameId?: string;
    channelId?: string;
    environment?: string;
    pushToStartToken?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { gameId, channelId, environment, pushToStartToken } = body;
  if (
    !gameId || !/^\d{8}[A-Z]{4}\d$/.test(gameId) ||
    !channelId || typeof channelId !== "string" ||
    (environment !== "production" && environment !== "sandbox") ||
    !pushToStartToken || typeof pushToStartToken !== "string"
  ) {
    return NextResponse.json({ error: "invalid params" }, { status: 400 });
  }

  // device-auth: 토큰 실존 검증 → user_id도 이 행에서 얻는다(클라 주장 아님).
  const { data: tokenRow, error: tokenErr } = await supabase
    .from("live_activity_start_tokens")
    .select("user_id")
    .eq("push_to_start_token", pushToStartToken)
    .maybeSingle();
  if (tokenErr) return supabaseErrorResponse(tokenErr);
  if (!tokenRow) {
    return NextResponse.json({ error: "unknown token" }, { status: 401 });
  }

  // 채널 유효성: 그 (game, env)의 *현재 active* 채널과 일치할 때만 수락 —
  // 지난 경기/폐기 채널 ACK는 409로 거절(클라는 폐기, 재시도 금지).
  const { data: chanRow, error: chanErr } = await supabase
    .from("live_activity_channels")
    .select("channel_id")
    .eq("game_id", gameId)
    .eq("environment", environment)
    .eq("status", "active")
    .maybeSingle();
  if (chanErr) return supabaseErrorResponse(chanErr);
  if (!chanRow || chanRow.channel_id !== channelId) {
    return NextResponse.json({ error: "channel not active" }, { status: 409 });
  }

  const deviceKey = createHash("sha256").update(pushToStartToken).digest("hex");
  const { error: upErr } = await supabase.from("live_activity_channel_subscriptions").upsert(
    {
      game_id: gameId,
      device_key: deviceKey,
      environment,
      channel_id: channelId,
      user_id: tokenRow.user_id,
      confirmed_at: new Date().toISOString(),
    },
    { onConflict: "game_id,device_key,environment" },
  );
  if (upErr) return supabaseErrorResponse(upErr);

  // 구독 확정 → 같은 (user, game)의 stale update 토큰 삭제(이중 발송 방지, 스펙 v4 §서버 4).
  await supabase
    .from("live_activity_tokens")
    .delete()
    .eq("user_id", tokenRow.user_id)
    .eq("game_id", gameId);

  return NextResponse.json({ success: true });
}
