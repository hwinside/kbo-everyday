/** R2 scripts-only intervention; production rendering and evidence stay intact. */
import { buildOfficialContextRequest } from "../../../src/lib/baseball-qa/rag/official-context-request";
import type { RagEvidence, RagRequestExtras } from "../../../src/lib/baseball-qa/rag/retrieve";
export const INTENT_ROUTING_NOTE = [
  "문맥 질문에서는 답할 대상을 먼저 확정한 뒤 자료의 관련성을 판단한다. 직전 사용자 질문과 현재 질문으로 대상을 정하며, 이전 답변의 사실 주장은 근거로 쓰지 않는다.",
  "용어 설명에 대한 정정·비교라면 두 개념의 정의와 관계가 답할 대상이다. 검색 자료가 특정 규칙의 특수 상황만 설명한다면 그 상황을 사용자가 물었다고 간주하지 않는다. 일반 개념으로 답할 수 있는 관계는 GENERAL 기준으로 직접 설명한다. 관련 없는 공식 자료가 존재한다는 이유만으로 GROUNDED로 바꾸지 않는다.",
  "반대로 현재 질문 자체가 구체적인 적용 조건·예외·판정·기록을 묻는다면 공식 근거로 그 질문에 답한다. 직전 질문의 유형을 현재 질문에 상속하지 않는다. 실제 규칙 질문에 직접 근거가 부족하면 GENERAL로 우회하지 않는다.",
  "지시 대상이 문맥으로도 정해지지 않으면 임의의 상황을 만들어내지 않고 기존 불충분 기준을 따른다. 상태 스키마·숫자·출처 제한은 그대로 유지한다.",
].join("\n");
export function intentRoutingRequest(question: string, evidence: RagEvidence[], extras?: RagRequestExtras) {
  const request = buildOfficialContextRequest(question, evidence, extras);
  if (!extras?.context) return request;
  return {...request, systemInstruction: {...request.systemInstruction,
    parts: [{text: `${request.systemInstruction.parts[0].text}\n${INTENT_ROUTING_NOTE}`} ]}};
}
