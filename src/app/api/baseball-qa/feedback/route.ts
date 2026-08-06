// 야잘알봇 답변 품질 피드백 (👍/👎) 적재 경로.
//
// 범위는 **적재까지만**이다 — 이 route 는 답변 생성·라우팅·캐시를 한 줄도 건드리지 않는다.
// 피드백을 캐시·사전·골든셋으로 승격하는 자동화 루프는 하린아빠 HOLD 상태다(2026-08-05 18:02).
//
// 소유권 검증을 여기서 하는 이유: 테이블은 RLS 전면 차단(service_role 전용)이라
// 클라가 직접 쓸 수 없다. 대신 "이 답변 쪽지가 정말 이 유저의 야잘알봇 대화 것인가"를
// 서버가 확인해야 임의 message_id 로 남의 답변에 표를 던지는 것을 막는다.
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import {
  BASEBALL_GENIUS_USER_ID,
  isGeniusReplyPayload,
} from "@/lib/constants/baseball-genius";
import { isFeedbackEligibleReplyKind } from "@/lib/baseball-qa/answer-feedback";

export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });

  let answerMessageId: unknown;
  let rating: unknown;
  let expectedPrev: unknown;
  try {
    ({ answerMessageId, rating, expectedPrev } = await req.json());
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  if (!Number.isSafeInteger(answerMessageId) || Number(answerMessageId) <= 0) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  // 1 = 좋아요, -1 = 별로. 중립(0)은 없다 — 취소는 같은 값 재클릭이다.
  if (rating !== 1 && rating !== -1) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  // 취소 판정 근거. 없거나(구 클라) 형식이 틀리면 NULL → 토글하지 않고 확정(set)한다.
  // 모르는 상태에서 임의로 취소로 해석하면 유저 표를 지운다 — fail-safe 는 "확정" 쪽이다.
  const expectedPrevValue: 1 | -1 | null =
    expectedPrev === 1 || expectedPrev === -1 ? expectedPrev : null;

  // ── 소유권 검증 ──────────────────────────────────────────────────────────────
  // ① 그 쪽지가 야잘알봇 발신인가  ② 그 대화에 이 유저가 참여자인가
  // 둘 다 통과해야 한다. 하나만 보면 남의 대화 답변에 표를 던질 수 있다.
  const { data: message, error: messageError } = await supabaseAdmin
    .from("dm_messages")
    .select("id, sender_id, payload, conversation_id, dm_conversations!inner(user1_id,user2_id)")
    .eq("id", answerMessageId)
    .eq("sender_id", BASEBALL_GENIUS_USER_ID)
    .maybeSingle();
  const conversation = message?.dm_conversations as unknown as
    | { user1_id: string | null; user2_id: string | null }
    | undefined;
  if (
    messageError ||
    !message ||
    !conversation ||
    ![conversation.user1_id, conversation.user2_id].includes(verified.user.id)
  ) {
    return NextResponse.json({ error: "평가할 답변을 확인할 수 없습니다" }, { status: 403 });
  }

  // ── 종결 응답 검증 (삼순 NO-GO ③) ──────────────────────────────────
  // 발신자만 보면 야잘알봇이 보낸 **안내·시스템 메시지·ack·picker 중간상태**에도 POST 가
  // 통과한다. UI 가 버튼을 안 그려도 API 를 직접 치면 그만이다 — 적재 계약을 깨는 오염이라
  // **UI 와 같은 판정 함수**로 서버에서도 강제한다(계약 이중화 금지).
  //
  // 구 payload(=`type` 이 없거나 reply_kind 미기록) 도 여기서 막는다. 어느 질문·경로였는지
  // 모르는 표는 분석에 못 쓰고, question_message_id 가 없으면 질문로그와 결속도 못 한다.
  const payload = isGeniusReplyPayload(message.payload) ? message.payload : null;
  if (!payload || !isFeedbackEligibleReplyKind(payload.reply_kind)) {
    return NextResponse.json({ error: "평가할 수 없는 메시지입니다" }, { status: 400 });
  }
  // 질문 쪽지 id.
  //
  // ⚠️ **필수로 강제하지 않는다** (삼순 2차 blocker ①). 운영 실측(2026-08-06):
  // eligible 답변 1,096건 중 `question_message_id` 보유는 **0건**이다. qid 를 싣는 코드는
  // 이번 배포분부터 적용되므로, 필수로 두면 **기존 대화창의 모든 답변이 400** 이 된다.
  // 유저는 버튼을 누를 수 있는데 저장만 실패하는 상태다.
  //
  // 대신 **없으면 NULL 로 적재**한다. 없는 값을 시간창 추정으로 지어내지도 않고
  // (오적재), 표 자체를 버리지도 않는다. 결속 가능 여부는 분석 시점에 qid IS NOT NULL 로
  // 가른다 — "질문과 결속된 표"와 "답변 단위 표"는 둘 다 유용한 지표다.
  const rawQuestionMessageId = payload.question_message_id;
  const questionMessageId =
    Number.isSafeInteger(rawQuestionMessageId) && Number(rawQuestionMessageId) > 0
      ? Number(rawQuestionMessageId)
      : null;

  // 같은 값 재클릭이면 취소, 다른 값이면 변경. 판정을 route 에서 SELECT→분기→WRITE 로
  // 하면 두 탭 동시 클릭에서 read-modify-write 경합이 난다. DB 단일 statement 로 넘긴다.
  // query-guard: bounded -- (user_id, answer_message_id) unique 단일 행 갱신 RPC.
  const { data: finalRating, error: rpcError } = await supabaseAdmin
    .rpc("set_baseball_genius_answer_feedback", {
      p_user_id: verified.user.id,
      p_answer_message_id: Number(answerMessageId),
      p_question_message_id: questionMessageId,
      p_match_path: payload.match_path ?? null,
      p_reply_kind: payload.reply_kind,
      p_rating: rating,
      p_expected_prev: expectedPrevValue,
    });
  if (rpcError) {
    console.error("baseball-genius feedback failed:", rpcError.message);
    return NextResponse.json({ error: "평가를 저장할 수 없습니다" }, { status: 503 });
  }

  // 최종 상태를 그대로 돌려준다. null = 취소됨.
  return NextResponse.json({
    ok: true,
    rating: finalRating === null || finalRating === undefined ? null : Number(finalRating),
  });
}

export async function GET(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });

  // 대화 화면 진입 시 내가 이미 누른 표를 복원한다. 이게 없으면 재접속마다 버튼이
  // 초기 상태로 보여서 유저가 다시 누르고, 같은 값이면 취소되어 표가 사라진다.
  const url = new URL(req.url);
  const ids = (url.searchParams.get("answerMessageIds") ?? "")
    .split(",")
    .map((raw) => Number(raw.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  if (ids.length === 0) return NextResponse.json({ ok: true, ratings: {} });
  // 화면에 그려지는 쪽지는 100건 상한이므로 그 이상은 받지 않는다(무한 IN 방지).
  if (ids.length > 100) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }

  // 본인 데이터만 읽는다. user_id 를 요청에서 받지 않고 검증된 세션에서만 취한다.
  // query-guard: bounded -- 상한 100건 id IN 조회.
  const { data, error } = await supabaseAdmin
    .from("genius_answer_feedback")
    .select("answer_message_id, rating")
    .eq("user_id", verified.user.id)
    .in("answer_message_id", ids);
  if (error) {
    console.error("baseball-genius feedback read failed:", error.message);
    return NextResponse.json({ error: "평가를 불러올 수 없습니다" }, { status: 503 });
  }

  const ratings: Record<string, number> = {};
  for (const row of data ?? []) {
    ratings[String((row as { answer_message_id: number }).answer_message_id)] =
      Number((row as { rating: number }).rating);
  }
  return NextResponse.json({ ok: true, ratings });
}
