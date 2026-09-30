import type { ValidatedRagAnswer } from "./retrieve";

export const RAG_EVIDENCE_HOLD = "확인한 자료만으로는 질문하신 내용을 충분히 뒷받침하기 어렵습니다. 확인되지 않은 내용을 단정하지 않겠습니다.";
export const RAG_DATE_HOLD = "확인한 자료로는 해당 시즌의 일정 날짜를 검증하지 못했습니다. 확인되지 않은 날짜는 안내하지 않겠습니다.";
export const RAG_NUMBER_HOLD = "답변에 필요한 수치나 날짜를 확인한 자료로 검증하지 못했습니다. 확인되지 않은 값을 단정하지 않겠습니다.";
export const RAG_RESPONSE_HOLD = "검증된 답변을 마련하지 못해 이번에는 정확히 안내하기 어렵습니다.";

/** Render an existing validator decision, never reclassify the user's intent.
 * No claim that all official sources lack the fact; no claim that a clearer
 * question would supply missing evidence. Routes, reasons and guards stay intact. */
export function renderRagHold(value: ValidatedRagAnswer): string {
  if (value.kind !== "insufficient") return RAG_RESPONSE_HOLD;
  switch (value.reason) {
    case "event_date_unverified": return RAG_DATE_HOLD;
    case "numeric_claim_ungrounded":
    case "numeric_not_in_evidence":
    case "numeric_not_in_question": return RAG_NUMBER_HOLD;
    case "model_insufficient": return RAG_EVIDENCE_HOLD;
    default: return RAG_RESPONSE_HOLD;
  }
}
