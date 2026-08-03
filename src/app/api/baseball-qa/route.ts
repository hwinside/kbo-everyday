// 야잘알봇 고정 DM 응답 즉시 처리 경로. 사용자 메시지 행을 검증한 뒤 공용 처리기를 호출한다.
// 브라우저가 여기까지 못 와도(앱 종료/응답 단절) 질문 INSERT trigger가 만든 job을
// /api/cron/baseball-qa-drain 이 durable 하게 이어서 처리한다.
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { processBaseballQaQuestion } from "@/lib/baseball-qa/server";
import { BASEBALL_GENIUS_USER_ID } from "@/lib/constants/baseball-genius";

export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });

  let conversationId: unknown;
  let messageId: unknown;
  let pickedPlayerKboId: unknown;
  try {
    ({ conversationId, messageId, pickedPlayerKboId } = await req.json());
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  if (typeof conversationId !== "string" || !Number.isSafeInteger(messageId) || Number(messageId) <= 0) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  // 동명이인 picker 선택값. 형식만 검증하고(길이·문자종), 실제로 그 id가 로스터에 있는지는
  // 파이프라인이 확인한다(`resolvePickedPlayerCandidate`) — 없는 id면 무시되어 기존 경로로 간다.
  if (
    pickedPlayerKboId !== undefined && pickedPlayerKboId !== null &&
    (typeof pickedPlayerKboId !== "string" ||
      !/^[A-Za-z0-9]{1,16}$/.test(pickedPlayerKboId))
  ) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }

  const { data: message, error: messageError } = await supabaseAdmin
    .from("dm_messages")
    .select("id, sender_id, content, conversation_id, dm_conversations!inner(user1_id,user2_id)")
    .eq("id", messageId)
    .eq("conversation_id", conversationId)
    .eq("sender_id", verified.user.id)
    .maybeSingle();
  const conversation = message?.dm_conversations as unknown as
    | { user1_id: string | null; user2_id: string | null }
    | undefined;
  if (
    messageError ||
    !message ||
    !conversation ||
    ![conversation.user1_id, conversation.user2_id].includes(BASEBALL_GENIUS_USER_ID) ||
    ![conversation.user1_id, conversation.user2_id].includes(verified.user.id)
  ) {
    return NextResponse.json({ error: "야잘알봇 대화의 질문을 확인할 수 없습니다" }, { status: 403 });
  }

  const outcome = await processBaseballQaQuestion({
    messageId: Number(messageId),
    conversationId,
    userId: verified.user.id,
    question: message.content,
    pickedPlayerKboId: typeof pickedPlayerKboId === "string" ? pickedPlayerKboId : null,
  });
  if (outcome.kind === "pending") {
    return NextResponse.json({ ok: false, pending: true }, { status: 202 });
  }
  if (outcome.kind === "failed") {
    return NextResponse.json({ error: outcome.reason }, { status: outcome.status });
  }
  if (outcome.deduped) return NextResponse.json({ ok: true, deduped: true });
  return NextResponse.json({
    ok: true,
    source: outcome.source,
    remaining: outcome.remaining,
    conversationId: outcome.conversationId,
  });
}
