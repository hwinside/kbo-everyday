import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { verifyAccessTokenLive } from "@/lib/auth/verified-user";
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

    // 토큰으로 유저 검증.
    // ⚠️ 여기만 Live(서버 왕복) 검증을 쓴다 — 아래 가입일 컷오프가 auth 유저의
    // `created_at`을 필요로 하는데, 이 값은 JWT claims에 없다. 로컬 검증으로
    // 바꾸면 created_at이 undefined가 되어 컷오프 조건이 통째로 falsy가 되고
    // → 기존 유저 전원에게 환영 DM이 발송된다. 신규 가입 시 1회만 호출되는
    // 저빈도 경로라 왕복 1회를 유지해도 CPU 영향이 없다.
    const user = await verifyAccessTokenLive(token);
    if (!user) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    // 자기 자신이 운영자면 skip
    if (user.id === systemUserId) {
      return NextResponse.json({ ok: true, skipped: true });
    }

    // 가입일 기준: 배포 이후 가입한 유저에게만 발송 (기존 유저 오발송 방지).
    //
    // ⚠️ fail-CLOSED (삼순 blocker③). 종전 조건은 `createdAt && …` 이라
    // createdAt 이 없거나 파싱 불가하면 조건이 통째로 falsy → 그대로 발송으로
    // 진행했다. 즉 이 컷오프의 유일한 방어선이 "값이 항상 온다"는 가정 위에
    // 있었고, single-flight 혼선이나 응답 드리프트 한 번이면 **전체 기존
    // 유저에게 환영 DM** 이 나간다. 값을 못 믿으면 보내지 않는다.
    const DEPLOY_DATE = process.env.WELCOME_DM_CUTOFF || "2026-04-08T00:00:00Z";
    const cutoffMs = new Date(DEPLOY_DATE).getTime();
    if (!Number.isFinite(cutoffMs)) {
      console.error("[welcome-dm] invalid WELCOME_DM_CUTOFF:", DEPLOY_DATE);
      return NextResponse.json(
        { ok: false, skipped: true, reason: "invalid_cutoff" },
        { status: 500 },
      );
    }
    const userCreatedAt = user.createdAt;
    const createdAtMs = userCreatedAt ? new Date(userCreatedAt).getTime() : NaN;
    if (!Number.isFinite(createdAtMs)) {
      // 가입일을 확인할 수 없으면 신규 여부를 판정할 수 없다 → 발송하지 않는다.
      console.error("[welcome-dm] missing/invalid createdAt — skipping (fail-closed)");
      return NextResponse.json(
        { ok: false, skipped: true, reason: "unknown_created_at" },
        { status: 500 },
      );
    }
    if (createdAtMs < cutoffMs) {
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
