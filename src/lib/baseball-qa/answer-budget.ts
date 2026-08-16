/**
 * 야잘알봇 답변 **예산 SSOT** — 서빙 문자 상한과 생성 토큰 상한을 한 곳에서 정한다.
 *
 * 왜 별도 모듈인가 (삼순 2026-08-16 NO-GO P0). 종전에는 세 곳이 따로 있었다:
 *   · `RAG_ANSWER_MAX_CHARS` / `RAG_OFFICIAL_ANSWER_MAX_CHARS` (rag/retrieve.ts)
 *   · `BASEBALL_GENIUS_MAX_ANSWER_LENGTH` (constants/baseball-genius.ts)
 *   · `maxOutputTokens` 리터럴 (rag/retrieve.ts · gemini-request.ts)
 * 상한 320→700 상향에서 앞의 셋만 올리고 **`maxOutputTokens: 256` 을 그대로 뒀다.**
 * 그 상태에서 모델이 700자를 쓰려 하면 응답 JSON 이 중간에 끊겨(`finishReason: MAX_TOKENS`)
 * `validateRagResponse` 가 `malformed` 로 폐기한다 — 답이 풍부해지는 게 아니라 **죽는다**.
 * 문자 상한과 토큰 상한은 같은 예산의 두 단위이므로 **한 모듈에서 파생**시킨다.
 *
 * ── 토큰 상한 근거 (2026-08-16 실측, `gemini-flash-lite-latest`) ──────────────
 * (1) `countTokens` 로 700자 답변을 JSON 래핑(`{"status":...,"answer":...}`)해 잰 값:
 *       서술형 372 · 규칙 조문형 392 · 수치 혼합형 500 · **지표 최대밀도 552**
 *     한글은 토큰 효율이 좋지만 숫자·영문 지표(`wRC+ 128`·`OPS 0.812`)가 촘촘하면
 *     같은 700자가 552토큰까지 든다. 최악값을 기준으로 잡아야 한다.
 * (2) `generateContent` 실호출로 절단 경계를 확인한 값(700자 목표 지시):
 *       max=256 → `MAX_TOKENS`, JSON 파싱 **실패**
 *       max=384 → `MAX_TOKENS`, JSON 파싱 **실패**
 *       max=512 → `STOP`, 640자 정상
 *     즉 종전 256 은 700자는커녕 **465자 지점에서 이미 잘리고 있었다.**
 *
 * 그래서 1,024 = 실측 최악(552)의 약 1.85배. 여유를 두는 이유는 두 가지다.
 *   · `countTokens` 는 우리가 만든 표본의 값이고, 실제 모델 출력의 토큰 분포는 더 넓다.
 *   · 상한에 닿으면 결과가 "조금 짧아짐"이 아니라 **JSON 파손 → 전량 폐기**다.
 *     즉 이 값의 실패 모드는 비대칭이라 넉넉한 쪽으로 틀리는 것이 옳다.
 * 비용은 **실제 생성한 토큰만** 과금되므로 상한을 올리는 것 자체는 비용을 늘리지 않는다.
 */

/**
 * 서빙 답변 본문(출처 표기 제외) 문자 상한.
 *
 * 160(초기) → 320(2026-08-10 "긴 답변이 필요한 경우는 충분히 길게")
 *          → 700(2026-08-16 "전반적인 답변이 너무 짧게 즉답형").
 *
 * ⚠️ 이 값은 **목표 길이가 아니라 안전 상한**이다. 유형별 길이는
 * `BASEBALL_GENIUS_DEPTH_PROMPT` 가 정하고, 이 값은 장문 복붙(원문 재발행)을 막는
 * 마지막 방어선이다. tier1·tier2·generic 이 **전부 이 상수를 파생**해 쓰므로
 * 경로별로 길이가 갈라질 수 없다(종전에는 세 리터럴이 각각 320이라 갈라질 수 있었다).
 */
export const BASEBALL_GENIUS_ANSWER_MAX_CHARS = 700;

/**
 * Gemini `generationConfig.maxOutputTokens`.
 *
 * 위 실측대로 최악 밀도 700자가 552토큰이므로, 그보다 넉넉히 잡는다.
 * 파생식으로 쓰지 않고 상수로 두되 아래 `assertAnswerBudgetCoherent` 가 관계를 강제한다 —
 * 문자 상한만 올리고 토큰을 두는 이번 같은 사고를 구조로 막는다.
 */
export const BASEBALL_GENIUS_MAX_OUTPUT_TOKENS = 1_024;

/**
 * 700자 답변이 JSON 래핑까지 포함해 실측으로 소비한 **최악 토큰 수**(2026-08-16, 지표 최대밀도).
 * 게이트가 "토큰 상한이 문자 상한을 실제로 감당하는가"를 판정하는 기준선이다.
 */
export const BASEBALL_GENIUS_MEASURED_WORST_TOKENS_PER_MAX_ANSWER = 552;

/**
 * 문자 상한 ↔ 토큰 상한 정합성.
 *
 * 순수 함수로 노출해 게이트가 **production 값 그대로** 태울 수 있게 한다
 * (게이트가 조건을 재기술하면 상수를 바꿔도 게이트만 통과하는 false-green 이 된다).
 *
 * 반환값이 `null` 이면 정합, 문자열이면 그 사유가 곧 위반이다.
 */
export function answerBudgetViolation(
  maxChars: number = BASEBALL_GENIUS_ANSWER_MAX_CHARS,
  maxOutputTokens: number = BASEBALL_GENIUS_MAX_OUTPUT_TOKENS,
  worstMeasuredTokens: number = BASEBALL_GENIUS_MEASURED_WORST_TOKENS_PER_MAX_ANSWER,
): string | null {
  if (maxOutputTokens < worstMeasuredTokens) {
    return `토큰 상한(${maxOutputTokens})이 실측 최악(${worstMeasuredTokens}토큰/${maxChars}자)보다 작다 — 상한 답변이 JSON 절단으로 폐기된다`;
  }
  // 실측은 우리가 만든 표본이고 실제 출력 분포는 더 넓다. 최소 1.5배 여유를 계약으로 둔다.
  if (maxOutputTokens < Math.ceil(worstMeasuredTokens * 1.5)) {
    return `토큰 상한(${maxOutputTokens})의 여유가 실측 최악의 1.5배(${Math.ceil(worstMeasuredTokens * 1.5)}) 미만이다 — 절단 실패 모드가 비대칭(전량 폐기)이라 여유가 필요하다`;
  }
  return null;
}
