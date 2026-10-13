import type { PreviousTurnRow } from "./context";
import { unpackStoredQaFinal } from "./pipeline";

/** v1/v2 RPC row. v2 adds the exact previous job's durable envelope text. */
export interface PreviousTurnRowSql {
  question: string | null;
  answer: string | null;
  job_source: string | null;
  answered_at: string | null;
  current_created_at: string | null;
  definition_llm_text?: string | null;
}

/** The RPC joins metadata by exact previous message ID, never by question text. */
export function previousTurnFromSql(row: PreviousTurnRowSql | null | undefined): PreviousTurnRow | null {
  if (!row) return null;
  const final = row.definition_llm_text ? unpackStoredQaFinal(row.definition_llm_text) : null;
  const definitionContext = final?.source === row.job_source ? final?.definitionContext : undefined;
  const rankRequestContext = final?.source === row.job_source ? final?.rankRequestContext : undefined;
  const rosterRemovalContext = final?.source === row.job_source ? final?.rosterRemovalContext : undefined;
  const transferPeriodContext = final?.source === row.job_source ? final?.transferPeriodContext : undefined;
  return {
    question: row.question, answer: row.answer, jobSource: row.job_source,
    answeredAt: row.answered_at, currentCreatedAt: row.current_created_at,
    ...(definitionContext ? { definitionContext } : {}),
    ...(rankRequestContext ? { rankRequestContext } : {}),
    ...(rosterRemovalContext ? { rosterRemovalContext } : {}),
    ...(transferPeriodContext ? { transferPeriodContext } : {}),
  };
}
