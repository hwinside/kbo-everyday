import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { verifyAccessToken } from "@/lib/auth/verified-user";
import { NextRequest, NextResponse } from "next/server";

const WELCOME_MESSAGE = `안녕하세요, 크보팬 운영팀입니다 ⚾

여기는 한국 프로야구 팬들이 함께 경기 보고, 선수 이야기하고, 티켓/구장 정보까지 나누는 공간이에요.

이런 것도 해보세요:
• 최애선수를 5명까지 추가 지정하기
• 커뮤니티 글 하나 읽고 댓글 남기기
• 궁금한 점이나 불편한 점이 있으면 마이페이지 > 피드백 보내기로 문의하기

크보팬은 팬들이 같이 만드는 서비스예요.
써보시면서 아쉬운 점 있으면 편하게 '피드백 보내기'로 알려주세요 :)`;

export async function POST(request: NextRequest) {
  const systemUserId = process.env.SYSTEM_USER_ID;

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !systemUserId) {
    return NextResponse.json({ ok: false, reason: "missing_config" }, { status: 500 });
  }

  // Bearer 토큰으로 유저 검증
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const admin = getSupabaseAdmin();

    // 토큰으로 유저 검증 (로컬 exp 프리체크 + dead-token 캐시)
    const user = await verifyAccessToken(token);
    if (!user) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    // 자기 자신이 운영자면 skip
    if (user.id === systemUserId) {
      return NextResponse.json({ ok: true, skipped: true });
    }

    // 가입일 기준: 배포 이후 가입한 유저에게만 발송 (기존 유저 오발송 방지)
    const DEPLOY_DATE = process.env.WELCOME_DM_CUTOFF || "2026-04-08T00:00:00Z";
    const userCreatedAt = user.created_at;
    if (userCreatedAt && new Date(userCreatedAt) < new Date(DEPLOY_DATE)) {
      return NextResponse.json({ ok: true, skipped: true, reason: "existing_user" });
    }

    // 신규 안드 가입자 긴급공지 자동발송은 /api/push/register-device(서버 검증 platform)로 이관
    // (삼순 NO-GO #3 — 클라 body.platform 미신뢰, 토큰 등록 성공 시점에 발송).

    // 정렬해서 저장 (user1 < user2)
    const [u1, u2] = [systemUserId, user.id].sort();

    // 이미 운영자와 대화가 있으면 skip (서버 기준 중복 방지)
    const { data: existing } = await admin
      .from("dm_conversations")
      .select("id")
      .eq("user1_id", u1)
      .eq("user2_id", u2)
      .maybeSingle();

    if (existing) {
      return NextResponse.json({ ok: true, skipped: true });
    }

    // 대화 생성 (service_role → RLS 우회)
    const { data: conv, error: convError } = await admin
      .from("dm_conversations")
      .insert({ user1_id: u1, user2_id: u2 })
      .select("id")
      .single();

    if (convError || !conv) {
      console.error("welcome-dm conv create error:", convError);
      return NextResponse.json({ ok: false, reason: "conv_create_failed" }, { status: 500 });
    }

    // 환영 메시지 전송 (운영자 계정으로)
    const { error: msgError } = await admin
      .from("dm_messages")
      .insert({
        conversation_id: conv.id,
        sender_id: systemUserId,
        content: WELCOME_MESSAGE,
      });

    if (msgError) {
      console.error("welcome-dm msg error:", msgError);
      return NextResponse.json({ ok: false, reason: "msg_send_failed" }, { status: 500 });
    }

    // last_message 업데이트
    await admin
      .from("dm_conversations")
      .update({
        last_message: WELCOME_MESSAGE.substring(0, 100),
        last_message_at: new Date().toISOString(),
      })
      .eq("id", conv.id);

    return NextResponse.json({ ok: true, conversationId: conv.id });
  } catch (e) {
    console.error("welcome-dm error:", e);
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 });
  }
}
