export const BASEBALL_QA_GEMINI_MODEL = "gemini-flash-lite-latest";

export function buildBaseballQaGeminiRequest(
  question: string,
  systemPrompt: string,
) {
  return {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: question }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
    },
  };
}
