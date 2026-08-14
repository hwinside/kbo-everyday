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
  "시그니처 ⚾는 인사·감사 같은 대화형 고정 응답에만 답변당 최대 1회 사용한다.",
  "유저의 지적이 자료로 확인되면 첫 문장을 '지적 감사합니다. 제가 실책했습니다. 정확히 다시 확인하겠습니다.'로 쓴다.",
  "오류를 인정할 때 야구 비유로 변명하거나 자기변호하지 않는다.",
].join("\n");

/**
 * 생성 답변을 denylist가 아니라 **문장 종결 구조**로 판정한다.
 * 봇이 서술하는 각 한국어 문장은 `-니다/-니까`로 끝나야 한다.
 */
const FORMAL_SENTENCE_ENDING_RE = /(?:니다|니까)$/u;
const HANGUL_RE = /[가-힣]/u;

export function isBaseballGeniusToneCompliant(answer: string): boolean {
  // `예:` 뒤의 따옴표 질문만 유저 입력 예시로 제외한다. 답 전체를 따옴표로 감싼 우회는 제외하지 않는다.
  const botSpeech = answer.replace(/예:\s*(?:(?:["“][^"”]*["”])\s*)+/gu, "");
  const lines = botSpeech.split(/\n+/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const trimmedLine = lines[lineIndex].trim();
    if (!trimmedLine || /^(?:📄\s*)?출처[:：]|^https?:\/\//u.test(trimmedLine)) continue;
    for (const rawSentence of trimmedLine.split(/(?<=[.!?…])\s+/u)) {
      let sentence = rawSentence
        .trim()
        .replace(/^[-*•]\s*/u, "")
        .replace(/[.!?…⚾\s]+$/u, "")
        .replace(/[:：]$/u, "")
        .trim()
        .replace(/\s*\([^()]*\)$/u, "")
        .replace(/["”'’\])}]+$/u, "")
        .trim()
        .replace(/^["“'‘]+|["”'’]+$/gu, "")
        .trim();
      if (!sentence || !HANGUL_RE.test(sentence)) continue;
      if (FORMAL_SENTENCE_ENDING_RE.test(sentence)) continue;
      // 정식 문장 뒤에 이어지는 선수명 등 다중행 목록 조각은 문장 종결 계약 대상이 아니다.
      const isListFragment = lines.length > 1 && lineIndex > 0 && !/[.!?…]$/u.test(rawSentence.trim());
      if (isListFragment) continue;
      return false;
    }
  }
  return true;
}
