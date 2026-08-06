/**
 * 야잘알봇 답변 품질 피드백(👍/👎) **클라이언트 계약**.
 *
 * React·Supabase 비의존 순수 모듈이다 — 회귀 게이트가 실제 배포 로직을 그대로 실행할 수
 * 있어야 하기 때문이다. 판정을 컴포넌트 인라인에 두면 게이트가 렌더 계약을 못 잡는다
 * (#1091 picker `isGeniusPickerDisabled` 와 같은 이유, 삼순 7차 P0-1).
 *
 * 범위: **적재까지만**. 이 값이 답변 라우팅·캐시·사전으로 되먹여지는 경로는 없다
 * (하린아빠 2026-08-05 18:02 자동화 루프 HOLD).
 */

/** 1 = 좋아요, -1 = 별로. `null` = 표 없음(취소된 상태 포함). 중립값 0은 만들지 않는다. */
export type GeniusFeedbackRating = 1 | -1;

export type GeniusFeedbackMap = Readonly<Record<number, GeniusFeedbackRating>>;

/**
 * 피드백을 받는 **종결 응답** reply_kind 폐쇄집합.
 *
 * 하린아빠 계약: "사용자 질문에 대해 낸 **모든 종결 응답**(answer/clarification/
 * unavailable/blocked 포함)에 👍/👎. 안내·시스템 메시지·thinking/ack 중간상태는 제외."
 *
 * 운영 DB 실측(2026-08-06, 답변 1,093건):
 *   answer      698  (llm·dictionary·cache·rag·kbo_structured)
 *   unavailable 391  (blocked·unsure=되묻기·history_hold·limited·service_redirect)
 *   ack           2  ← 순수 맞장구, 종결 응답 아님
 *   picker        1  ← 중간상태(선택 대기), 종결 아님
 *
 * 즉 `answer` + `unavailable` 이 계약의 종결 응답과 정확히 대응한다
 * (clarification=되묻기·blocked 는 이미 `unavailable` 에 들어 있다).
 *
 * ⚠️ 이전 구현은 `answer` 만 허용해 **391건(36%)을 무음 처리**했다. "못 답한 것"에
 * 대한 불만이야말로 가장 중요한 신호라 계약에 넣은 것이다. 지표 오염은 수집을 막아서가 아니라
 * `reply_kind` 를 같이 저장해 **후분석에서 분리**해 막는다.
 */
export const FEEDBACK_ELIGIBLE_REPLY_KINDS = ["answer", "unavailable"] as const;

export type FeedbackEligibleReplyKind = (typeof FEEDBACK_ELIGIBLE_REPLY_KINDS)[number];

/** 종결 응답인가 — UI·route 가 **같은** 이 함수를 쓴다(계약 이중화 금지). */
export function isFeedbackEligibleReplyKind(
  replyKind: string | null | undefined,
): replyKind is FeedbackEligibleReplyKind {
  return (
    typeof replyKind === "string" &&
    (FEEDBACK_ELIGIBLE_REPLY_KINDS as readonly string[]).includes(replyKind)
  );
}

/**
 * 답변 쪽지에 피드백 버튼을 붙일 것인가.
 *
 * payload 가 없는 과거 답변은 제외한다 — 어느 경로였는지 모르는 표는 분석에 못 쓴다.
 * (없는 값을 지어내지 않는다.)
 */
export function shouldShowFeedback(
  senderId: string | null,
  geniusUserId: string,
  replyKind: string | null | undefined,
): boolean {
  if (senderId === null || senderId !== geniusUserId) return false;
  return isFeedbackEligibleReplyKind(replyKind);
}

/**
 * 클릭 결과의 **낙관적 다음 상태**를 계산한다.
 * 같은 값 재클릭 = 취소(null), 다른 값 = 변경. 서버 RPC 와 같은 규칙이며,
 * 서버 응답이 오면 그 값으로 덮어쓴다(서버가 SSOT).
 */
export function nextRatingAfterClick(
  current: GeniusFeedbackRating | null | undefined,
  clicked: GeniusFeedbackRating,
): GeniusFeedbackRating | null {
  return current === clicked ? null : clicked;
}

export interface FeedbackSubmitResult {
  ok: boolean;
  rating: GeniusFeedbackRating | null;
}

/**
 * 피드백 전송. 실패는 **조용히 삼키지 않고** ok:false 로 돌려준다 —
 * 호출부가 낙관적 상태를 되돌려야 유저가 "눌렀는데 안 눌린" 상태를 보지 않는다.
 */
export async function submitGeniusFeedback(
  answerMessageId: number,
  rating: GeniusFeedbackRating,
  accessToken: string | null,
  request: typeof fetch = fetch,
): Promise<FeedbackSubmitResult> {
  try {
    const response = await request("/api/baseball-qa/feedback", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ answerMessageId, rating }),
    });
    if (!response.ok) return { ok: false, rating: null };
    const body = (await response.json()) as { rating?: unknown };
    const value = body.rating;
    if (value === 1 || value === -1) return { ok: true, rating: value };
    return { ok: true, rating: null };
  } catch {
    return { ok: false, rating: null };
  }
}

/** 화면에 그려진 답변들의 내 표를 복원한다. 실패하면 빈 맵 — 버튼은 미투표로 보인다. */
export async function loadGeniusFeedback(
  answerMessageIds: readonly number[],
  accessToken: string | null,
  request: typeof fetch = fetch,
): Promise<GeniusFeedbackMap> {
  if (answerMessageIds.length === 0) return {};
  try {
    const response = await request(
      `/api/baseball-qa/feedback?answerMessageIds=${answerMessageIds.join(",")}`,
      {
        credentials: "include",
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      },
    );
    if (!response.ok) return {};
    const body = (await response.json()) as { ratings?: Record<string, unknown> };
    const out: Record<number, GeniusFeedbackRating> = {};
    for (const [key, value] of Object.entries(body.ratings ?? {})) {
      const id = Number(key);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      if (value === 1 || value === -1) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}
