/** R4-reviewed context instruction, rendered inside the existing official call. */
import { buildRagLlmRequest, RAG_OFFICIAL_SYSTEM_PROMPT, type RagEvidence, type RagRequestExtras } from "./retrieve";

export const CONTEXT_ROUTING_NOTE = [
  "현재 질문을 직전 사용자 질문의 문맥에서 먼저 해석한다. 직전 답변은 오류일 수 있으며 정답 근거가 아니다.",
  "사용자가 직전 용어 설명을 정정하거나 두 개념의 관계를 묻는다면 그 관계에 답한다. 검색 자료에만 등장하는 특수 상황을 질문의 전제로 추가하지 않는다.",
  "일반 개념의 관계를 묻고 자료가 그 관계를 직접 설명하지 않을 때만 기존 GENERAL 기준으로 답한다. 직전 질문이 일반 용어였다는 이유만으로 현재 규칙 질문을 GENERAL로 바꾸지 않는다.",
  "현재 질문이 적용 조건·예외·판정·기록을 묻는다면 제공된 공식 근거를 유지한다. 적용 조건의 부정도 해당 규칙의 근거로 답할 수 있다. 근거 부족을 일반 지식으로 우회하지 않는다.",
  "현재 질문이 독립된 새 질문이면 직전 문맥을 사용하지 않는다. 기존 상태·숫자·출처 제한을 그대로 지킨다.",
].join("\n");

export function buildOfficialContextRequest(question: string, evidence: RagEvidence[], extras?: RagRequestExtras) {
  // Official mode is selected by exact prompt identity inside the builder.
  // Finish all official rendering first; only then append the context instruction.
  const request = buildRagLlmRequest(question, evidence, RAG_OFFICIAL_SYSTEM_PROMPT, extras);
  if (!extras?.context) return request;
  return {
    ...request,
    systemInstruction: {
      ...request.systemInstruction,
      parts: [{ text: `${request.systemInstruction.parts[0].text}\n${CONTEXT_ROUTING_NOTE}` }],
    },
  };
}

