import type { ValidatedRagAnswer } from "./retrieve";

export const RAG_NEUTRAL_HOLD = "이 내용은 지금 정확히 답변드리기 어렵습니다.";
export const RAG_DATE_HOLD = "작성한 답변을 자료와 대조해 검증하지 못해 안내를 보류했습니다.";
export const RAG_NUMBER_HOLD = "작성한 답변의 수치를 확인한 자료로 검증하지 못해 안내를 보류했습니다.";
export const RAG_RESPONSE_HOLD = "검증된 답변을 마련하지 못해 이번에는 정확히 안내하기 어렵습니다.";

/** Render an existing validator decision, never reclassify the user's intent.
 * No claim that all official sources lack the fact; no claim that a clearer
 * question would supply missing evidence. Routes, reasons and guards stay intact. */
export function renderRagHold(value: ValidatedRagAnswer): string {
  if (value.kind !== "insufficient") return RAG_RESPONSE_HOLD;
  switch (value.reason) {
    // This validates model-produced calendar metadata, not the user's intent.
    // A non-date answer can carry spurious claims (e.g. a standings year).
    // Keep HOLD, but do not diagnose a missing schedule date from this reason.
    case "event_date_unverified": return RAG_DATE_HOLD;
    case "numeric_not_in_evidence": return RAG_NUMBER_HOLD;
    // These guards do not establish an evidence deficit: tier2 numbers are
    // blocked without comparison; GENERAL numbers may be absent from the
    // question even when the user never asked for a numeric answer.
    case "numeric_claim_ungrounded":
    case "numeric_not_in_question":
    case "model_insufficient": return RAG_NEUTRAL_HOLD;
    default: return RAG_RESPONSE_HOLD;
  }
}
