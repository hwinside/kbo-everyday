import { pairedClassifierMetrics } from "../../src/lib/baseball-qa/classifier-metrics";
/** Author-written gate. Independent execution/verdict belongs to reviewer. No network. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { observeQaDeps, intentOutputOutcome, providerFailure, readClassifierObservation } from "../../src/lib/baseball-qa/classifier-observation";
import { evaluateIntentOutput, evaluateProductionCase, majorityOfThree, evaluateGeneralStatus } from "../../src/lib/baseball-qa/classifier-evaluation";
import { buildQuestionLogRow } from "../../src/lib/baseball-qa/log-row";
import { buildBaseballQaGeminiRequest, BASEBALL_QA_SYSTEM_PROMPT } from "../../src/lib/baseball-qa/gemini-request";
import { selectContextTurn } from "../../src/lib/baseball-qa/context";
import type { QaDeps, LlmResult } from "../../src/lib/baseball-qa/pipeline";

async function main() {
  assert.deepEqual(majorityOfThree(["A", "B", "A"]), { label: "A", unstable: true });
  assert.equal(majorityOfThree(["A", "B", "C"]).label, "UNSTABLE_NO_MAJORITY");
  assert.equal(evaluateGeneralStatus("TERM_CONTEXTUAL").intent, "RULE_TERM");
  const paired = pairedClassifierMetrics([{ gold: "A", baseline: "PROVIDER_ERROR", candidate: "A" }], ["A"]);
  assert.equal(paired.n, 1);
  assert.equal(paired.delta.accuracy, 1);
  assert.deepEqual(paired.ci95.macroF1, [1, 1]);
  assert.throws(() => pairedClassifierMetrics([], ["A"]));
  const logs: Parameters<QaDeps["log"]>[0][] = [];
  let stored: LlmResult | null = null;
  const base: QaDeps = {
    loadGlossary: async () => [], loadPlayers: async () => [], getCache: async () => null,
    setCache: async () => {}, reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    callLlm: async () => ({ text: '{"status":"BASEBALL_RULE_TERM","answer":"RULE_TERM"}', inputTokens: 2, outputTokens: 3 }),
    log: async e => { logs.push(e); }, storeLlm: async r => { stored = r; },
    getLlmState: async () => ({ started: !!stored, result: stored }),
  };
  const logEntry = { userId: "test", question: "오타니 홈런 몇개", questionNorm: "오타니홈런몇개", matchPath: "stat_clarify" as const, answer: null, inputTokens: null, outputTokens: null };
  const observed = observeQaDeps(base);
  observed.setContextSelected(true);
  const result = await observed.deps.callLlm(logEntry.question, undefined, undefined, true);
  await observed.deps.storeLlm!(result);
  await observed.deps.log(logEntry);
  assert.equal(logs[0].classifierObservation?.statIntentMode, true);
  assert.equal(logs[0].classifierObservation?.intentOutcome, "rule_term");
  const retry = observeQaDeps(base);
  retry.setContextSelected(false);
  await retry.deps.getLlmState!();
  await retry.deps.log(logEntry);
  assert.deepEqual(logs[1].classifierObservation, logs[0].classifierObservation);
  stored = { text: "legacy", inputTokens: null, outputTokens: null };
  await retry.deps.getLlmState!();
  await retry.deps.log(logEntry);
  assert.equal(logs[2].classifierObservation?.providerOutcome, "legacy_unknown");
  assert.equal(logs[2].classifierObservation?.statIntentMode, null);
  assert.equal(readClassifierObservation({ version: 1, calls: -1 }), null);
  assert.equal(intentOutputOutcome('{"status":"NOT_BASEBALL","answer":""}'), "out_of_scope");
  assert.equal(intentOutputOutcome('{"status":"UNSURE","answer":""}'), "unsure");
  assert.equal(intentOutputOutcome('not json'), "invalid_json");
  assert.equal(intentOutputOutcome('{"status":"BASEBALL_RULE_TERM","answer":"free prose"}'), "invalid_answer");
  assert.equal(intentOutputOutcome('{"status":"TERM_CONTEXTUAL","answer":"context"}'), "invalid_status");
  assert.equal(evaluateIntentOutput(result.text).route, "rule_term_reask");
  assert.equal(evaluateIntentOutput('{"status":"NOT_BASEBALL"}').route, "stat_clarify");
  assert.equal(providerFailure(new DOMException("deadline", "TimeoutError")), "timeout");
  assert.equal(providerFailure(new Error("Gemini API failed: 503")), "http_5xx");
  assert.equal(providerFailure(new Error("Gemini API failed: 429")), "http_error");
  const error = new Error("Gemini API failed: 503");
  const failure = observeQaDeps({ ...base, callLlm: async () => { throw error; } });
  await assert.rejects(failure.deps.callLlm("q", undefined, undefined, true), e => e === error);
  await failure.deps.log(logEntry);
  assert.equal(logs.at(-1)?.classifierObservation?.providerFailures, 1);
  assert.equal(logs.at(-1)?.classifierObservation?.intentOutcome, null);
  const independent = observeQaDeps(base);
  await independent.deps.log(logEntry);
  assert.equal(logs.at(-1)?.classifierObservation?.calls, 0);

  const row = { question: "보크가 뭐야?", answer: "투수의 반칙 투구야.", jobSource: "llm", answeredAt: "2026-09-22T01:00:00Z", currentCreatedAt: "2026-09-22T01:01:00Z" };
  const context = selectContextTurn(row);
  assert.ok(context);
  assert.equal(selectContextTurn({ ...row, currentCreatedAt: "2026-09-22T02:00:00Z" }), null);
  assert.equal(selectContextTurn({ ...row, answeredAt: null }), null);
  const request = buildBaseballQaGeminiRequest("오타니 홈런 몇개", BASEBALL_QA_SYSTEM_PROMPT, context!, undefined, true);
  assert.ok(JSON.stringify(request).includes("오타니 홈런 몇개"));
  assert.ok(JSON.stringify(request).includes("보크가 뭐야?"));
  // Actual pipeline integration: forced quota terminal must never call provider.
  const run = await evaluateProductionCase({ caseId: "quota", question: "오타니 홈런 몇개", userId: "isolated-test" }, () => ({
    ...base, reserveDaily: async () => ({ allowed: false, remaining: 0 }),
    callLlm: async () => { throw new Error("must not call"); },
  }));
  assert.equal(run.result.source, "limited");
  assert.equal(run.logs[0].question, "오타니 홈런 몇개");
  assert.equal(run.logs[0].classifierObservation?.providerOutcome, "not_called");

  const db = new PGlite();
  try {
    await db.exec('CREATE TABLE genius_question_logs (id integer); CREATE TABLE genius_question_jobs (id integer, llm_text text); INSERT INTO genius_question_logs VALUES (1);');
    const migration = readFileSync("supabase/migrations/20260922030000_classifier_observation.sql", "utf8");
    await db.exec(migration);
    await db.exec(migration); // additive migration is replay safe
    const old = await db.query('SELECT stat_intent_mode, context_selected, provider_outcome FROM genius_question_logs WHERE id=1');
    assert.deepEqual(old.rows[0], { stat_intent_mode: null, context_selected: null, provider_outcome: null });
    const built = buildQuestionLogRow(logs[0], 42);
    await db.query('INSERT INTO genius_question_logs (id,stat_intent_mode,context_selected,provider_outcome,classifier_observation) VALUES (2,$1,$2,$3,$4)', [built.stat_intent_mode,built.context_selected,built.provider_outcome,JSON.stringify(built.classifier_observation)]);
    const saved = await db.query<{ classifier_observation: unknown }>('SELECT classifier_observation FROM genius_question_logs WHERE id=2');
    assert.deepEqual(readClassifierObservation(saved.rows[0].classifier_observation), logs[0].classifierObservation);
    await db.query('INSERT INTO genius_question_jobs (id,llm_text,classifier_observation) VALUES (1,$1,$2)', [result.text, JSON.stringify(logs[0].classifierObservation)]);
    const job = await db.query<{ classifier_observation: unknown }>('SELECT classifier_observation FROM genius_question_jobs WHERE id=1');
    assert.deepEqual(readClassifierObservation(job.rows[0].classifier_observation), logs[0].classifierObservation);
  } finally { await db.close(); }
  console.log("classifier observation: provider/parser/context/replay/log-row/migration contracts PASS");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
