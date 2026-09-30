import type { RagEvidence } from "./retrieve";

/** Exact quotes prove provenance, not semantic contradiction. The model's
 * decision still needs independent true/false/unknown correction replay. */
export const TEAM_CORRECTION_PROMPT = [
  "정정 판정과 사실 설명을 분리해서 응답 스키마로 반환한다. 사과·감사·자기 오류 인정 문장은 애플리케이션이 정정 판정으로 렌더링하므로 answer에는 자료로 설명할 사실만 쓴다.",
  "먼저 previousClaim에 이번 질문이 정정하려는 직전 봇 답변의 주장을 원문 그대로 인용한다. 정정 요청이 아니거나 직전 주장이 없으면 빈 문자열이다. 사용자 주장을 봇의 주장으로 바꾸지 않는다.",
  "correctionEvidence에는 판정에 직접 관련된 자료 번호(정수)와 자료 본문의 원문 인용을 반환한다. 직전 대화와 사용자 주장은 사실 근거가 아니다. 해당 근거가 없으면 빈 배열이다.",
  "correction=previous_answer_wrong은 인용한 자료가 previousClaim을 실제로 반박할 때만 선택한다. 사용자가 이의를 제기했다는 사실만으로 선택하지 않는다.",
  "correction=user_claim_unsupported는 사용자의 정정 주장이 자료와 다르거나 자료로 확인할 수 없을 때다. 이전 답이 자료와 일치하면 봇의 오류가 아니다. 근거 부족일 때는 정오를 단정하지 않고 확인할 수 있는 범위를 설명한다.",
  "correction=none은 대상 선택·후속 설명·주제 전환처럼 정정이 아닌 질문이다. 정정 의도를 새로 만들어내지 않는다.",
].join("\n");

export const TEAM_CORRECTION_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    previousClaim: { type: "STRING" },
    correctionEvidence: { type: "ARRAY", items: { type: "OBJECT", properties: {
      evidence: { type: "INTEGER" }, quote: { type: "STRING" },
    }, required: ["evidence", "quote"] } },
    correction: { type: "STRING", enum: ["none", "previous_answer_wrong", "user_claim_unsupported"] },
    status: { type: "STRING", enum: ["GROUNDED", "INSUFFICIENT"] },
    answer: { type: "STRING" },
  },
  required: ["previousClaim", "correctionEvidence", "correction", "status", "answer"],
  propertyOrdering: ["previousClaim", "correctionEvidence", "correction", "status", "answer"],
} as const;

export const VERIFIED_CORRECTION_ACK = "지적 감사합니다. 제가 실책했습니다.";

/** Runs once at the team-provider boundary, before normal RAG validation and
 * durable final-envelope storage. No phrase scanning, removal or second call.
 * Invalid contract/references fail closed; other providers are unchanged. */
export function renderTeamCorrection(
  raw: string, evidence: RagEvidence[], context?: { question: string; answer: string },
): string {
  const invalid = () => JSON.stringify({ status: "INSUFFICIENT", answer: "", correctionError: "invalid_correction_contract" });
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (!["none", "previous_answer_wrong", "user_claim_unsupported"].includes(String(row.correction))
    || typeof row.previousClaim !== "string" || !Array.isArray(row.correctionEvidence)
    || !["GROUNDED", "INSUFFICIENT"].includes(String(row.status)) || typeof row.answer !== "string") return invalid();
  if (row.previousClaim && !context?.answer.includes(row.previousClaim)) return invalid();
  for (const citation of row.correctionEvidence) {
    if (!citation || typeof citation !== "object" || !Number.isInteger(citation.evidence)
      || citation.evidence < 1 || citation.evidence > evidence.length
      || typeof citation.quote !== "string" || !citation.quote.trim()
      || !evidence[citation.evidence - 1].content.includes(citation.quote)) return invalid();
  }
  if (row.correction === "previous_answer_wrong") {
    if (!row.previousClaim.trim() || !context || row.correctionEvidence.length === 0) return invalid();
    if (row.status === "GROUNDED" && row.answer.trim()) {
      return JSON.stringify({ ...row, factualAnswer: row.answer, answer: `${VERIFIED_CORRECTION_ACK} ${row.answer.trim()}` });
    }
  }
  return JSON.stringify(row);
}
