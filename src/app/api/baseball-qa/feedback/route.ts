// 야잘알봇 답변 품질 피드백 (👍/👎) 적재 경로.
//
// 범위는 **적재까지만**이다 — 이 route 는 답변 생성·라우팅·캐시를 한 줄도 건드리지 않는다.
// 피드백을 캐시·사전·골든셋으로 승격하는 자동화 루프는 하린아빠 HOLD 상태다(2026-08-05 18:02).
//
// 대상은 **RAG/사전 근거로 답한 답변만**이다 (하린아빠 2026-08-06 16:36·16:37).
// 스몰톡·인사·되묻기·미응답·근거 없는 LLM 생성답은 UI 에도 안 붙고 여기서도 400 으로 막힌다.
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
import { isFeedbackEligible } from "@/lib/baseball-qa/answer-feedback";

export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });

  let answerMessageId: unknown;
  let desired: unknown;
  let expectedPrev: unknown;
  try {
    ({ answerMessageId, desired, expectedPrev } = await req.json());
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  if (!Number.isSafeInteger(answerMessageId) || Number(answerMessageId) <= 0) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  // **원하는 최종 상태**(set semantics). 1 = 좋아요, -1 = 별로, null = 취소.
  // "같은 값이면 취소"를 서버가 다시 판정하지 않는다 — 그 판정이 재전송·두 탭에서
  // 첫 저장을 두 번째 요청이 뒤집는 원인이었다(삼순 08-06 P0).
  if (desired !== 1 && desired !== -1 && desired !== null) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  // CAS 비교값. 클라가 클릭 직전에 보고 있던 상태.
  if (expectedPrev !== 1 && expectedPrev !== -1 && expectedPrev !== null && expectedPrev !== undefined) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
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

  // ── 피드백 대상 검증 ─────────────────────────────────────────────────────────
  // 발신자만 보면 야잘알봇이 보낸 **스몰톡 생성답·안내·ack·picker 중간상태**에도 POST 가
  // 통과한다. UI 가 버튼을 안 그려도 API 를 직접 치면 그만이다 — 적재 계약을 깨는 오염이라
  // **UI 와 같은 판정 함수**로 서버에서도 강제한다(계약 이중화 금지).
  //
  // 이 한 줄이 막는 것: llm(스몰톡)·cache·kbo_structured·unavailable·ack·picker,
  // 그리고 질문 결속 id 가 없는 구 payload 전부.
  const payload = isGeniusReplyPayload(message.payload) ? message.payload : null;
  if (
    !payload ||
    !isFeedbackEligible(payload.reply_kind, payload.match_path, payload.question_message_id)
  ) {
    return NextResponse.json({ error: "평가할 수 없는 메시지입니다" }, { status: 400 });
  }
  const questionMessageId = Number(payload.question_message_id);

  // ── 질문 로그 exact 결속 (삼순 08-06 P0) ─────────────────────────────────────
  // 피드백은 "이 질문에 대한 이 경로의 답변"에 붙어야 분석에 쓸 수 있다. 시간창 추정이
  // 아니라 **행 단위 FK** 로 못박는다. (user_id, question_message_id, match_path) 로
  // 조회해 **정확히 1행**일 때만 통과시킨다.
  //
  // 왜 0/N 을 fail-close 하는가:
  //  · 0행 — 로그 없이 발송된 답변이다. 결속할 대상이 없으므로 표를 만들지 않는다.
  //  · N행 — 어느 로그에 붙일지 결정할 근거가 없다. 임의로 고르면 오적재다.
  // (picker → 재처리 흐름은 같은 messageId 로 `player_picker` 와 최종 경로 로그를 각각
  //  남기지만 match_path 가 달라 이 조회에서는 1행으로 갈린다. 실측으로 확인했다.)
  // query-guard: bounded -- (user_id, question_message_id, match_path) 로 1행을 기대하고 2행 이상은 모호로 거절하므로 limit 2 로 족하다.
  const { data: logRows, error: logError } = await supabaseAdmin
    .from("genius_question_logs")
    .select("id")
    .eq("user_id", verified.user.id)
    .eq("question_message_id", questionMessageId)
    .eq("match_path", payload.match_path)
    .limit(2);
  if (logError) {
    console.error("baseball-genius feedback log lookup failed:", logError.message);
    return NextResponse.json({ error: "평가를 저장할 수 없습니다" }, { status: 503 });
  }
  if (!logRows || logRows.length !== 1) {
    return NextResponse.json({ error: "평가할 수 없는 메시지입니다" }, { status: 400 });
  }
  const questionLogId = (logRows[0] as { id: string }).id;

  // ── CAS 적용 ─────────────────────────────────────────────────────────────────
  // 판정을 route 에서 SELECT→분기→WRITE 로 하면 두 탭 동시 클릭에서 read-modify-write
  // 경합이 난다. DB 함수가 advisory lock 안에서 비교·적용까지 한다.
  // query-guard: bounded -- (user_id, answer_message_id) unique 단일 행 갱신 RPC.
  const { data: casResult, error: rpcError } = await supabaseAdmin
    .rpc("set_baseball_genius_answer_feedback", {
      p_user_id: verified.user.id,
      p_answer_message_id: Number(answerMessageId),
      p_question_message_id: questionMessageId,
      p_question_log_id: questionLogId,
      p_match_path: payload.match_path,
      p_reply_kind: payload.reply_kind,
      p_desired: desired,
      p_expected_prev: expectedPrevValue,
    });
  if (rpcError) {
    console.error("baseball-genius feedback failed:", rpcError.message);
    return NextResponse.json({ error: "평가를 저장할 수 없습니다" }, { status: 503 });
  }

  const outcome = (casResult ?? {}) as { rating?: number | null; applied?: boolean };
  const finalRating =
    outcome.rating === 1 || outcome.rating === -1 ? outcome.rating : null;
  // 충돌이면 409 + **실제 상태**. 클라가 그 값으로 화면을 맞춰야 UI 와 DB 가 갈라지지 않는다
  // (직전 구현은 적용 실패를 성공 NULL 로 보고해 다른 탭의 표를 화면에서 지웠다).
  if (outcome.applied !== true) {
    return NextResponse.json(
      { ok: false, conflict: true, rating: finalRating },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, rating: finalRating });
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
