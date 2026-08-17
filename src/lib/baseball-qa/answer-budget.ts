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
 * 실측 기준이 된 **문자 수**. 아래 토큰 실측값은 이 길이에서 잰 것이다.
 *
 * ⚠️ 실측값과 그 측정 조건은 반드시 함께 둔다. 조건 없이 토큰만 두면 문자 상한을
 * 1,400 으로 올려도 "552토큰이면 충분"이라는 낡은 판정이 그대로 통과한다
 * (삼순 2026-08-16 P1 — `maxChars` 를 받고도 계산에 안 쓰던 결함).
 */
export const BASEBALL_GENIUS_MEASURED_AT_CHARS = 700;

/**
 * 위 길이의 답변이 JSON 래핑까지 포함해 실측으로 소비한 **최악 토큰 수**
 * (2026-08-16, `gemini-flash-lite-latest`, 지표 최대밀도 표본).
 * 게이트가 "토큰 상한이 문자 상한을 실제로 감당하는가"를 판정하는 기준선이다.
 */
export const BASEBALL_GENIUS_MEASURED_WORST_TOKENS_PER_MAX_ANSWER = 552;

/** 절단 실패 모드가 비대칭(전량 폐기)이라 요구하는 최소 여유율. */
export const BASEBALL_GENIUS_TOKEN_HEADROOM_RATIO = 1.5;

/**
 * `maxChars` 길이 답변의 **실측 기준 최악 토큰 수** — 스케일 계산의 유일한 자리.
 *
 * ⚠️ 이 식을 다른 곳에 복제하지 않는다. 두 곳에 두면 한쪽만 바꿔도 다른 쪽이 가려
 * **결함주입이 통과**한다(2026-08-16 m4f2 검출력 0 으로 실측). 스케일이 한 지점이면
 * 그 지점을 변이시켰을 때 반드시 RED 가 된다.
 *
 * 실측은 `BASEBALL_GENIUS_MEASURED_AT_CHARS` 에서 잰 값이라 **문자수에 선형 비례**로
 * 스케일한다(한국어+JSON 래핑의 토큰/문자 비는 길이에 대체로 선형이다).
 */
export function scaledWorstTokensFor(
  maxChars: number,
  worstMeasuredTokens: number = BASEBALL_GENIUS_MEASURED_WORST_TOKENS_PER_MAX_ANSWER,
  measuredAtChars: number = BASEBALL_GENIUS_MEASURED_AT_CHARS,
): number {
  return Math.ceil((worstMeasuredTokens * maxChars) / measuredAtChars);
}

/**
 * 문자 상한 `maxChars` 를 감당하려면 최소 몇 토큰이 필요한가.
 * 실측 비례값(`scaledWorstTokensFor`)에 여유율을 곱한다 — 상한에 닿으면
 * "조금 짧아짐"이 아니라 JSON 파손 → 전량 폐기라 실패 모드가 비대칭이다.
 */
export function requiredOutputTokensFor(
  maxChars: number,
  worstMeasuredTokens: number = BASEBALL_GENIUS_MEASURED_WORST_TOKENS_PER_MAX_ANSWER,
  measuredAtChars: number = BASEBALL_GENIUS_MEASURED_AT_CHARS,
  headroom: number = BASEBALL_GENIUS_TOKEN_HEADROOM_RATIO,
): number {
  return Math.ceil(scaledWorstTokensFor(maxChars, worstMeasuredTokens, measuredAtChars) * headroom);
}

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
  // ⚠️ `maxChars` 를 **반드시 계산에 쓴다**(삼순 2026-08-16 P1). 종전에는 인자로 받고도
  //    메시지에만 끼워 넣어, 문자 상한을 1,400 으로 올려도 1024 토큰이 정합으로 통과했다.
  //    스케일 식은 `scaledWorstTokensFor` 한 곳에만 있다(복제 금지 — 위 주석 참조).
  const scaledWorst = scaledWorstTokensFor(maxChars, worstMeasuredTokens);
  if (maxOutputTokens < scaledWorst) {
    return `토큰 상한(${maxOutputTokens})이 ${maxChars}자 기준 실측 최악(${scaledWorst}토큰, ${BASEBALL_GENIUS_MEASURED_AT_CHARS}자에서 잰 ${worstMeasuredTokens}토큰을 비례 스케일)보다 작다 — 상한 답변이 JSON 절단으로 폐기된다`;
  }
  const required = requiredOutputTokensFor(maxChars, worstMeasuredTokens);
  if (maxOutputTokens < required) {
    return `토큰 상한(${maxOutputTokens})의 여유가 ${maxChars}자 기준 요구치(${required}토큰 = 실측 비례 ${scaledWorst} × ${BASEBALL_GENIUS_TOKEN_HEADROOM_RATIO}) 미만이다 — 절단 실패 모드가 비대칭(전량 폐기)이라 여유가 필요하다`;
  }
  return null;
}
