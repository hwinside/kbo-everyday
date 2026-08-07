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
 * 피드백을 받는 **라우팅 경로**(match_path) 폐쇄집합.
 *
 * 하린아빠 2026-08-06 16:36 → 16:37 최종:
 *   "스몰톡은 넣지마. 대화가 자연스러워지지 않아. 모든 스몰톡마다 저걸 넣기보다는
 *    **RAG를 통해 정보를 가져와 답변한 것들에 한해서** 해"
 *   "아.. **사전에서 가져온 답변 추가**"
 *
 * ⚠️ 이것은 "종결 응답 전체"(answer+unavailable)로 넓히자는 직전 방향을 하린아빠가
 * 뒤집은 결과다. "못 답한 것에 대한 불만도 신호"라는 지적 자체는 틀리지 않았지만,
 * 제품 판단은 "대화가 부자연스러워지는 비용"을 더 크게 본다. **재제기 금지.**
 *
 * ── 왜 reply_kind 가 아니라 match_path 로 가르는가 ──
 * `reply_kind === "answer"` 안에 근거 없는 순수 생성답(`llm`)이 같이 들어 있다.
 * 스몰톡이 떨어지는 곳이 바로 그 `llm` 이라, kind 만으로는 가를 수가 없다.
 *
 * 운영 DB 실측 (2026-08-06, 야잘알봇 발신 쪽지 전수):
 *   payload 없음         1,752   배포 전 생성분 → 제외(경로를 모른다)
 *   answer/llm             377   순수 생성답, 근거 없음. **스몰톡이 여기로 떨어진다** → 제외
 *   answer/dictionary      283   검수 사전에서 가져온 답 → **대상** (하린아빠 16:37)
 *   unavailable/*          392   못 답한 경로(blocked·unsure·history_hold·limited 등) → 제외
 *   answer/cache            22   과거 생성답의 캐시 → 제외(근거는 아래)
 *   answer/rag              20   문서 근거를 검색해 답함 → **대상**
 *   unavailable/rag          5   RAG 를 탔지만 못 답함 → 제외(reply_kind 축이 거른다)
 *   answer/kbo_structured    3   운영 DB 원값(순위표·팀기록). "가져온 정보"이긴 하나
 *                                RAG 도 사전도 아니다 → 제외, 하린아빠 판단 대기
 *   ack/picker               3   중간상태 → 제외
 *
 * `cache` 제외는 추측이 아니라 전수 확인이다: `deps.setCache` 는 pipeline.ts 에서
 * **`llm` 경로 한 곳에서만** 호출된다(1977줄, grep 결과 1건). RAG·사전 경로는 setCache 를
 * 호출하지 않으므로 cache hit 은 정의상 **과거 LLM 생성답**이다. 근거 있는 답이 아니다.
 *
 * ⚠️ **좁게 시작하는 것이 안전하다.** 나중에 경로를 더하는 건 이 배열에 한 줄이지만,
 * 이미 쌓인 오염된 표는 사후에 걷어낼 수 없다(어느 표가 오염인지 구분할 근거가 없다).
 */
// ⚠️ `team_rag` 를 빠뜨리면 구단 답변에서 피드백 버튼이 사라진다(#1118 회귀).
//   2026-08-07 에 구단 경로를 `rag` 에서 분리하면서 여기도 함께 넓혔다.
export const FEEDBACK_ELIGIBLE_MATCH_PATHS = ["rag", "team_rag", "dictionary", "kbo_structured"] as const;

export type FeedbackEligibleMatchPath = (typeof FEEDBACK_ELIGIBLE_MATCH_PATHS)[number];

/** 질문 쪽지 결속 id 로 쓸 수 있는 값인가. 결속 없는 표는 만들지 않는다. */
export function isBoundQuestionMessageId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/**
 * 피드백 대상인가 — UI·route 가 **같은** 이 함수를 쓴다(계약 이중화 금지, 삼순 NO-GO ③).
 *
 * 세 조건을 **모두** 요구한다:
 *  ① `match_path` 가 RAG 또는 사전 경로다 — 근거를 가져와 답한 것만
 *  ② `reply_kind === "answer"` 다 — 실제로 답변으로 나간 것만
 *  ③ 원 질문 쪽지 id 가 실려 있다 — 어느 질문에 대한 표인지 모르면 적재하지 않는다
 *
 * ②가 별도로 필요한 이유(실측 근거): 운영에 `unavailable/rag` 가 **5건** 있다.
 * match_path 만 보고 붙이면 화면에 "모르겠어요"로 보이는 쪽지에 답변 품질 표가 붙는다.
 *
 * ③이 필요한 이유(삼순 08-06 P0): 운영 답변 1,096건 전부 `question_message_id` 가 없다.
 * 이 조건이 없으면 **눌러도 400 으로 실패하는 버튼**이 과거 답변 전량에 붙는다.
 */
export function isFeedbackEligible(
  replyKind: string | null | undefined,
  matchPath: string | null | undefined,
  questionMessageId: unknown,
): boolean {
  if (replyKind !== "answer") return false;
  if (typeof matchPath !== "string") return false;
  if (!(FEEDBACK_ELIGIBLE_MATCH_PATHS as readonly string[]).includes(matchPath)) return false;
  return isBoundQuestionMessageId(questionMessageId);
}

/**
 * 답변 쪽지에 피드백 버튼을 붙일 것인가.
 *
 * payload 가 없는 과거 답변은 제외된다 — match_path·qid 가 undefined 라 통과하지 못한다.
 * 어느 경로였는지·어느 질문이었는지 모르는 표는 분석에 못 쓴다(없는 값을 지어내지 않는다).
 */
export function shouldShowFeedback(
  senderId: string | null,
  geniusUserId: string,
  replyKind: string | null | undefined,
  matchPath: string | null | undefined,
  questionMessageId: unknown,
): boolean {
  if (senderId === null || senderId !== geniusUserId) return false;
  return isFeedbackEligible(replyKind, matchPath, questionMessageId);
}

/**
 * 클릭 결과의 **원하는 최종 상태**를 계산한다.
 * 같은 값 재클릭 = 취소(null), 다른 값 = 변경. 이 값이 그대로 서버에 desired 로 간다
 * (서버가 "같은 값이면 취소"를 다시 판정하지 않는다 — 재전송이 표를 뒤집던 원인).
 */
export function nextRatingAfterClick(
  current: GeniusFeedbackRating | null | undefined,
  clicked: GeniusFeedbackRating,
): GeniusFeedbackRating | null {
  return current === clicked ? null : clicked;
}

export interface FeedbackSubmitResult {
  /** 요청이 서버에 도달해 최종 상태를 확인했는가. 네트워크/서버 실패면 false. */
  ok: boolean;
  /** 서버가 말하는 **실제** 최종 상태. 충돌(409)이면 내가 원한 값이 아니라 DB 의 값이다. */
  rating: GeniusFeedbackRating | null;
  /** CAS 충돌 — 다른 탭이 먼저 바꿨다. 호출부는 `rating` 으로 화면을 맞춘다. */
  conflicted?: boolean;
}

function parseRating(value: unknown): GeniusFeedbackRating | null {
  return value === 1 || value === -1 ? value : null;
}

/**
 * 피드백 전송. 실패는 **조용히 삼키지 않고** ok:false 로 돌려준다 —
 * 호출부가 낙관적 상태를 되돌려야 유저가 "눌렀는데 안 눌린" 상태를 보지 않는다.
 */
export async function submitGeniusFeedback(
  answerMessageId: number,
  /** **원하는 최종 상태**. null = 취소. 서버는 이 값을 그대로 목표로 삼는다(set semantics). */
  desired: GeniusFeedbackRating | null,
  accessToken: string | null,
  request: typeof fetch = fetch,
  /**
   * 이번 클릭 **직전에 유저가 보고 있던** 표. 서버 CAS 의 비교 대상이다.
   *
   * 서버가 "저장값 == 클릭값이면 취소"로 판정하면, 같은 요청이 두 번 도달할 때
   * (재전송·두 탭·retry) 첫 번째 저장을 두 번째가 취소로 뒤집는다. 유저는 한 번
   * 눌렀는데 표가 사라진다. 이전 상태는 클라만 알므로 같이 보낸다.
   */
  expectedPrev: GeniusFeedbackRating | null = null,
): Promise<FeedbackSubmitResult> {
  try {
    const response = await request("/api/baseball-qa/feedback", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ answerMessageId, desired, expectedPrev }),
    });
    // 409 = CAS 충돌. 실패가 아니라 **다른 탭이 먼저 바꿨다**는 사실이고, 서버가 실제
    // 상태를 함께 준다. 그 값으로 화면을 맞춰야 UI 와 DB 가 갈라지지 않는다.
    if (response.status === 409) {
      const body = (await response.json()) as { rating?: unknown };
      return { ok: true, rating: parseRating(body.rating), conflicted: true };
    }
    if (!response.ok) return { ok: false, rating: null };
    const body = (await response.json()) as { rating?: unknown };
    return { ok: true, rating: parseRating(body.rating) };
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
