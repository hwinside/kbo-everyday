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
 * 하린아빠 2026-08-06 16:36 — 직전 계약을 **명시 변경**했다:
 *   16:36 "스모톡은 넣지마. 대화가 자연스러워지지 않아. 모든 스모톡마다 저걸 넣기보다는
 *          **RAG를 통해 정보를 가져와 답변한 것들에 한해서** 해"
 *   16:37 "사전에서 가져온 답변 추가"
 *
 * ⚠️ 이것은 삼순 NO-GO ②("종결응답 전체로 복구")를 하린아빠가 뒤집은 결과다.
 * "못 답한 것에 대한 불만도 신호"라는 지적 자체는 틀리지 않았지만, 제품 판단은
 * "대화가 부자연스러워지는 비용"을 더 크게 본다. **재제기 금지.**
 *
 * 기준은 "생성"이 아니라 **"가져왔는가"** 다. `rag` 는 문서에서, `dictionary` 는
 * 검수 사전에서 가져온다 — 둘 다 답의 출처가 있어 품질 판정이 의미를 갖는다.
 * `llm` 은 모델이 지어낸 것이라 출처가 없고, 스모톡이 그리로 떨어진다.
 *
 * ── 왜 reply_kind 가 아니라 match_path 로 가르는가 ──
 * `reply_kind === "answer"` 안에 근거 없는 순수 생성답(`llm`)이 같이 들어 있다.
 * 스모톡이 떨어지는 곳이 바로 그 `llm` 이라, kind 만으로는 가를 수가 없다.
 *
 * 운영 DB 실측 (2026-08-06, 발송된 답변 payload 1,100건):
 *   answer/llm            376   순수 생성답, 근거 없음. **스모톡이 여기로 떨어진다** → 제외
 *   answer/dictionary     281   검수 사전에서 가져온 정의문 → **대상** (하린아빠 16:37 추가 지시)
 *   unavailable/*         390   못 답한 경로 → 제외(하린아빠 지시)
 *   answer/cache           22   과거 생성답의 캐시 → 제외(근거는 아래)
 *   answer/rag             20   문서 근거를 검색해 답함 → **대상**
 *   answer/kbo_structured   3   운영 DB 원값(순위표·팀기록). 정보를 가져오긴 하지만
 *                               문서검색(RAG)이 아니다 → 일단 제외, 하린아빠 판단 대기
 *   ack/picker              3   중간상태 → 제외
 *
 * `cache` 제외는 추측이 아니라 전수 확인이다: `deps.setCache` 는 pipeline.ts 에서
 * **`llm` 경로 한 곳에서만** 호출된다(1977줄, grep 결과 1건). RAG 경로는 setCache 를
 * 호출하지 않으므로 cache hit 은 정의상 **과거 LLM 생성답**이다. 근거 있는 답이 아니다.
 *
 * ⚠️ 경로를 더하는 건 이 배열에 한 줄이지만, **이미 쌓인 오염된 표는 사후에 걷어낼 수
 * 없다** (어느 표가 오염인지 구분할 근거가 없다). 그래서 대상 확대는 지시가 있을 때만 한다.
 * `reply_kind`·`match_path` 를 행마다 저장하는 이유도 이것이다 — 확대 이후에도 과거 표와
 * 신규 표를 분리해 읽을 수 있어야 한다.
 */
export const FEEDBACK_ELIGIBLE_MATCH_PATHS = ["rag", "dictionary"] as const;

export type FeedbackEligibleMatchPath = (typeof FEEDBACK_ELIGIBLE_MATCH_PATHS)[number];

/**
 * 피드백 대상인가 — UI·route 가 **같은** 이 함수를 쓴다(계약 이중화 금지, 삼순 NO-GO ③).
 *
 * 두 조건을 **모두** 요구한다:
 *  ① `match_path` 가 RAG 경로다 — 근거를 가져와 답한 것만
 *  ② `reply_kind === "answer"` 다 — 실제로 답변으로 나간 것만
 *
 * ②가 별도로 필요한 이유(실측 근거): 운영에 `unavailable/rag` 가 **5건** 있다.
 * match_path 만 보고 붙이면 화면에 "모르겠어요"로 보이는 쪽지에 답변 품질 표가 붙는
 * 오적재가 된다. 둘 다 건다.
 */
export function isFeedbackEligible(
  replyKind: string | null | undefined,
  matchPath: string | null | undefined,
): boolean {
  if (replyKind !== "answer") return false;
  if (typeof matchPath !== "string") return false;
  return (FEEDBACK_ELIGIBLE_MATCH_PATHS as readonly string[]).includes(matchPath);
}

/**
 * 답변 쪽지에 피드백 버튼을 붙일 것인가.
 *
 * payload 가 없는 과거 답변은 제외된다 — match_path 가 undefined 라 통과하지 못한다.
 * 어느 경로였는지 모르는 표는 분석에 못 쓴다(없는 값을 지어내지 않는다).
 */
export function shouldShowFeedback(
  senderId: string | null,
  geniusUserId: string,
  replyKind: string | null | undefined,
  matchPath: string | null | undefined,
): boolean {
  if (senderId === null || senderId !== geniusUserId) return false;
  return isFeedbackEligible(replyKind, matchPath);
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
  /**
   * 이번 클릭 **직전에 유저가 보고 있던** 표. 취소 판정의 유일한 근거다.
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
      body: JSON.stringify({ answerMessageId, rating, expectedPrev }),
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
