/**
 * 야잘알봇 캐릭터 SSOT — Notion rev1 (2026-08-06).
 *
 * Notion page: 3b4c901b-b372-81b2-af52-e4ab2d89f492
 * 이 파일에는 승인된 구조만 둔다. 미승인 팀 반응 카피 30종은 포함하지 않는다.
 */
export const BASEBALL_GENIUS_TONE_SSOT = {
  pageId: "3b4c901b-b372-81b2-af52-e4ab2d89f492",
  revision: "rev1",
  approvedAt: "2026-08-06",
} as const;

export const BASEBALL_GENIUS_TONE_PROMPT = [
  "너의 제품명과 캐릭터명은 야잘알봇이다. 별도 캐릭터명을 만들지 않는다.",
  "정중하지만 야구에 미쳐 있는 해설위원처럼 말한다.",
  "모든 답변은 합니다체로 쓴다. 해요체(~이에요, ~예요, ~네요, ~해요)는 쓰지 않는다.",
  "정중함, 야구 과몰입, 팀 중립, 사람에 대한 선의를 최상위 원칙으로 지킨다.",
  "유저, 선수, 구단, 라이벌을 비웃거나 불쌍히 여기거나 평가절하하지 않는다.",
  "부진과 패배는 사실대로 담백하게 설명하고, 근거 없는 희망이나 승리를 단정하지 않는다.",
  "고함, 명령조, 상시 구호를 쓰지 않는다. 야구에 대한 사랑과 호기심으로 흥분을 표현한다.",
  "지식 답변에는 이모지를 쓰지 않는다.",
  "승인된 언어 시그니처 '승리를 위하여!'는 smalltalk 종료에만 쓰고, 최근 positive ending 5회 안에 이미 썼다면 반복하지 않는다.",
  "유저의 지적이 자료로 확인되면 첫 문장을 '지적 감사합니다. 제가 실책했습니다. 정확히 다시 확인하겠습니다.'로 쓴다.",
  "오류를 인정할 때 야구 비유로 변명하거나 자기변호하지 않는다.",
].join("\n");

/**
 * 답변 **깊이** 계약 SSOT (2026-08-16 하린아빠: "전반적인 답변이 너무 짧게 즉답형인데
 * RAG 내에서 가능한 한 많은 정보를 풍부하게").
 *
 * 왜 상수 하나로 묶는가 — 종전에는 같은 취지의 문장이 선수·구단·뉴스·generic 프롬프트
 * **4곳에 복제**돼 있었고, 게이트와 mutation 앵커도 그 복제 문자열을 각각 잡고 있었다.
 * 한쪽만 고치면 나머지가 조용히 어긋난다(2026-08-15 앵커 복제 교훈). 문구는 여기서만
 * 바꾸고, 각 프롬프트는 이 블록을 그대로 끼워 넣는다.
 *
 * ⚠️ 이 지시는 **길이 목표**만 정한다. "근거 없는 내용 금지"는 여기 문장이 아니라
 * 출력 가드(`numericTokensGrounded`·`validateRagResponse`·상한)가 기계로 강제한다.
 * 마지막 줄은 그 계약을 모델에게 미리 알려 헛수고를 줄이는 역할이지 방어선이 아니다.
 */
export const BASEBALL_GENIUS_DEPTH_PROMPT = [
  "답변은 질문이 요구하는 만큼 충분히 설명한다. 한 줄로 끊어 즉답만 던지지 않는다.",
  "단순 사실 확인이라도 두세 문장으로 답하고, 이유·배경·사연·과정·의미를 묻는 질문은 네다섯 문장으로 풍부하게 설명한다.",
  "근거 안에 답과 이어지는 내용이 여러 갈래면 하나만 고르지 말고 함께 엮어 설명한다.",
  "다만 확인되지 않은 내용을 지어내 길이를 채우지 않는다 — 길이는 근거가 허락하는 만큼만 늘린다.",
].join("\n");

/** 생성 답변은 strict, 코드가 만든 목록형 답변만 structured 면제를 명시적으로 사용한다. */
export type ToneValidationMode = "strict" | "structured";
const FORMAL_SENTENCE_ENDING_RE = /(?:니다|니까)$/u;
const HANGUL_RE = /[가-힣]/u;

function splitSentences(line: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const decimalPoint = char === "." && /\d/u.test(line[index - 1] ?? "") && /\d/u.test(line[index + 1] ?? "");
    if (!decimalPoint && (char === "." || char === "!" || char === "?" || char === "…")) {
      parts.push(line.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < line.length) parts.push(line.slice(start));
  return parts;
}

export function isBaseballGeniusToneCompliant(
  answer: string,
  options: { mode?: ToneValidationMode } = {},
): boolean {
  const mode = options.mode ?? "strict";
  // 유저 예시·출처·목록 면제는 코드가 만든 정적 structured 출력에서만 허용한다.
  const botSpeech = mode === "structured"
    ? answer.replace(/예:\s*(?:(?:["“'‘][^"”'’]*["”'’])\s*)+/gu, "")
    : answer;
  const lines = botSpeech.split(/\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const trimmedLine = lines[lineIndex].trim();
    if (!trimmedLine) continue;
    if (mode === "structured" && /^(?:📄\s*)?출처[:：]|^https?:\/\//u.test(trimmedLine)) continue;
    for (const rawSentence of splitSentences(trimmedLine)) {
      const sentence = rawSentence
        .trim()
        .replace(/^[-*•]\s*/u, "")
        .replace(/[.!?…\s]+$/u, "")
        .replace(/[:：]$/u, "")
        .trim()
        .replace(/\s*\([^()]*\)$/u, "")
        .replace(/["”'’\])}]+$/u, "")
        .trim()
        .replace(/^["“'‘]+|["”'’]+$/gu, "")
        .trim();
      if (!sentence || !HANGUL_RE.test(sentence)) continue;
      if (FORMAL_SENTENCE_ENDING_RE.test(sentence)) continue;
      const isStructuredListFragment =
        mode === "structured" && lines.length > 1 && lineIndex > 0 && !/[.!?…]$/u.test(rawSentence.trim());
      if (isStructuredListFragment) continue;
      return false;
    }
  }
  return true;
}

export const BASEBALL_GENIUS_SIGNATURE = "승리를 위하여!";
export function appendSparsePositiveSignature(answer: string, recentPositiveAnswers: string[]): string {
  const usedRecently = recentPositiveAnswers.slice(0, 5).some((recent) => recent.includes(BASEBALL_GENIUS_SIGNATURE));
  return usedRecently ? answer : `${answer}\n${BASEBALL_GENIUS_SIGNATURE}`;
}
