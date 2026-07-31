export const BASEBALL_QA_GEMINI_MODEL = "gemini-flash-lite-latest";

/**
 * 선정된 소스 turn 1개의 Q/A만 컨텍스트로 넣는다 (spec §4.1 공통).
 * 히스토리 전체를 넣지 않으므로 타 대화·타 유저 누수 경로가 없다.
 */
export function buildBaseballQaGeminiRequest(
  question: string,
  systemPrompt: string,
  context?: { question: string; answer: string },
) {
  const contents = context
    ? [
        { role: "user", parts: [{ text: context.question }] },
        { role: "model", parts: [{ text: context.answer }] },
        { role: "user", parts: [{ text: question }] },
      ]
    : [{ role: "user", parts: [{ text: question }] }];
  return {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
    },
  };
}
