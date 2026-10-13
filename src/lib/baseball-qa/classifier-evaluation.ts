import { answerQuestion, type QaDeps, type QaResult } from "./pipeline";
import { intentOutputOutcome } from "./classifier-observation";

/** Intent label mapping is not a substitute for the terminal pipeline result. */
export function evaluateIntentOutput(raw: string) {
  const outcome = intentOutputOutcome(raw);
  switch (outcome) {
    case "record": return { relevance: "IN_SCOPE", intent: "RECORD", route: "stat_clarify" } as const;
    case "narrative": return { relevance: "IN_SCOPE", intent: "NARRATIVE", route: "narrative_fixed" } as const;
    case "rule_term": return { relevance: "IN_SCOPE", intent: "RULE_TERM", route: "rule_term_reask" } as const;
    case "out_of_scope": return { relevance: "OUT_OF_SCOPE", intent: "UNRESOLVED", route: "stat_clarify" } as const;
    case "unsure": return { relevance: "NEEDS_CONTEXT", intent: "UNRESOLVED", route: "stat_clarify" } as const;
    default: return { relevance: "INVALID_OUTPUT", intent: "INVALID_OUTPUT", route: "stat_clarify" } as const;
  }
}

/**
 * Full production pipeline seam, not the old forced-mode/two-turn component baseline.
 * Caller supplies isolated dependencies per run (quota/cache/durable state must not leak
 * between repetitions). loadPreviousTurn returns the same-user RPC row, not chosen
 * context; the production selector, TTL, injection filter and request builder remain owners.
 * Never accepts question_norm as the source field. No data extraction or provider calls
 * happen merely by importing this module.
 */
export async function evaluateProductionCase(
  input: { caseId: string; question: string; userId: string },
  createDeps: () => QaDeps | Promise<QaDeps>,
): Promise<{ caseId: string; result: QaResult; logs: Parameters<QaDeps["log"]>[0][] }> {
  if (typeof input.question !== "string") throw new Error("raw question is required");
  const deps = await createDeps();
  const logs: Parameters<QaDeps["log"]>[0][] = [];
  const result = await answerQuestion(input.userId, input.question, {
    ...deps,
    log: async entry => { logs.push(entry); await deps.log(entry); },
  });
  return { caseId: input.caseId, result, logs };
}

export function evaluateGeneralStatus(status: unknown) {
  if (status === "BASEBALL_RULE_TERM") return { relevance: "IN_SCOPE", intent: "UNRESOLVED" } as const;
  if (status === "TERM_UNVERIFIED" || status === "TERM_CONTEXTUAL") return { relevance: "IN_SCOPE", intent: "RULE_TERM" } as const;
  if (status === "NOT_BASEBALL") return { relevance: "OUT_OF_SCOPE", intent: "UNRESOLVED" } as const;
  if (status === "UNSURE") return { relevance: "NEEDS_CONTEXT", intent: "UNRESOLVED" } as const;
  return { relevance: "INVALID_OUTPUT", intent: "INVALID_OUTPUT" } as const;
}

export function majorityOfThree(labels: readonly [string, string, string]) {
  const majority = labels.find(label => labels.filter(other => other === label).length >= 2);
  return { label: majority ?? "UNSTABLE_NO_MAJORITY", unstable: new Set(labels).size > 1 };
}

/** Repetitions are sequential, with fresh caller-owned state each time. */
export async function evaluateProductionTriplet(
  input: Parameters<typeof evaluateProductionCase>[0],
  createDeps: Parameters<typeof evaluateProductionCase>[1],
  label: (run: Awaited<ReturnType<typeof evaluateProductionCase>>) => string,
) {
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await evaluateProductionCase(input, createDeps));
  const labels = runs.map(label) as [string, string, string];
  return { caseId: input.caseId, runs, labels, ...majorityOfThree(labels) };
}
