import type { QaDeps, LlmResult } from "./pipeline";
import { parseStatIntentToken } from "./stat-intent-parser";

export const PROVIDER_OUTCOMES = ["not_called", "ok", "timeout", "http_5xx", "http_error", "provider_error", "legacy_unknown"] as const;
export type ProviderOutcome = typeof PROVIDER_OUTCOMES[number];
export interface ClassifierObservation {
  version: 1;
  statIntentMode: boolean | null;
  contextSelected: boolean | null;
  providerOutcome: ProviderOutcome;
  /** Only generic/intent and answer-generating RAG calls; excludes mapper/embedding calls. */
  calls: number;
  providerFailures: number;
  intentOutcome: "record" | "narrative" | "rule_term" | "out_of_scope" | "unsure" | "invalid_json" | "invalid_status" | "invalid_answer" | null;
}

export function readClassifierObservation(value: unknown): ClassifierObservation | null {
  if (!value || typeof value !== "object") return null;
  const o = value as ClassifierObservation;
  if (o.version !== 1 || ![true, false, null].includes(o.statIntentMode) || ![true, false, null].includes(o.contextSelected)
    || !PROVIDER_OUTCOMES.includes(o.providerOutcome) || !Number.isSafeInteger(o.calls) || o.calls < 0
    || !Number.isSafeInteger(o.providerFailures) || o.providerFailures < 0 || o.providerFailures > o.calls
    || ![null, "record", "narrative", "rule_term", "out_of_scope", "unsure", "invalid_json", "invalid_status", "invalid_answer"].includes(o.intentOutcome)) return null;
  return { version: 1, statIntentMode: o.statIntentMode, contextSelected: o.contextSelected,
    providerOutcome: o.providerOutcome, calls: o.calls, providerFailures: o.providerFailures, intentOutcome: o.intentOutcome };
}

export function intentOutputOutcome(text: string): ClassifierObservation["intentOutcome"] {
  const intent = parseStatIntentToken(text);
  if (intent) return intent;
  let row: unknown;
  try { row = JSON.parse(text.trim()); } catch { return "invalid_json"; }
  if (!row || typeof row !== "object" || Array.isArray(row)) return "invalid_status";
  const status = (row as { status?: unknown }).status;
  if (status === "NOT_BASEBALL") return "out_of_scope";
  if (status === "UNSURE") return "unsure";
  return status === "BASEBALL_RULE_TERM" ? "invalid_answer" : "invalid_status";
}

export function providerFailure(error: unknown): ProviderOutcome {
  const e = error as { name?: string; message?: string; status?: number } | null;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timeout";
  // Production adapters throw bounded HTTP status messages; never persist error text.
  const status = e?.status ?? Number(e?.message?.match(/(?:API failed|HTTP)[: ]+(\d{3})/)?.[1]);
  if (status >= 500 && status <= 599) return "http_5xx";
  if (status >= 400 && status <= 499) return "http_error";
  return "provider_error";
}

/** Per-request wrapper; never mutates caller deps or changes response/routing decisions. */
export function observeQaDeps(original: QaDeps) {
  let observation: ClassifierObservation = { version: 1, statIntentMode: false, contextSelected: null,
    providerOutcome: "not_called", calls: 0, providerFailures: 0, intentOutcome: null };
  const snapshot = () => ({ ...observation });
  const deps = { ...original };
  const invoke = async (call: () => Promise<LlmResult>, intent = false) => {
    observation.calls++;
    if (intent) observation.statIntentMode = true;
    try {
      const result = await call();
      observation.providerOutcome = "ok";
      if (intent) observation.intentOutcome = intentOutputOutcome(result.text);
      return result;
    } catch (error) {
      observation.providerOutcome = providerFailure(error);
      observation.providerFailures++;
      throw error;
    }
  };
  deps.callLlm = (...args) => invoke(() => original.callLlm(...args), args[3] === true);
  if (original.callRagLlm) deps.callRagLlm = (...args) => invoke(() => original.callRagLlm!(...args));
  if (original.callTeamRagLlm) deps.callTeamRagLlm = (...args) => invoke(() => original.callTeamRagLlm!(...args));
  if (original.callNewsRagLlm) deps.callNewsRagLlm = (...args) => invoke(() => original.callNewsRagLlm!(...args));
  if (original.callOfficialRagLlm) deps.callOfficialRagLlm = (...args) => invoke(() => original.callOfficialRagLlm!(...args));
  deps.log = entry => original.log({ ...entry, classifierObservation: snapshot() });
  if (original.storeLlm) deps.storeLlm = result => original.storeLlm!({ ...result, classifierObservation: snapshot() });
  if (original.getLlmState) deps.getLlmState = async () => {
    const state = await original.getLlmState!();
    if (state.result) {
      observation = readClassifierObservation(state.result.classifierObservation) ?? {
        version: 1, statIntentMode: null, contextSelected: null, providerOutcome: "legacy_unknown",
        calls: 0, providerFailures: 0, intentOutcome: null,
      };
    }
    return state;
  };
  return { deps, setContextSelected: (selected: boolean) => { observation.contextSelected = selected; } };
}
