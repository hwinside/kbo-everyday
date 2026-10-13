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

/** Actual production PostgREST adapter -> local SQL -> fresh adapter read.
 * The bridge only translates transport; it never adds observation fields/defaults.
 * Unexpected URLs/methods fail closed instead of touching a network or real DB.
 */
async function verifyProductionJobRoundTrip(
  db: PGlite,
  observation: NonNullable<LlmResult["classifierObservation"]>,
) {
  const priorFetch = globalThis.fetch;
  const envKeys = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
  const priorEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "isolated-observation-gate";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "isolated-observation-gate";
  let writes = 0;
  let reads = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, "http://127.0.0.1:9");
    assert.equal(url.pathname, "/rest/v1/genius_question_jobs");
    const messageFilter = url.searchParams.get("message_id");
    assert.match(messageFilter ?? "", /^eq\.\d+$/);
    const messageId = Number(messageFilter!.slice(3));
    const columns = new Set(["llm_started", "llm_started_at", "llm_text", "llm_input_tokens", "llm_output_tokens", "classifier_observation", "updated_at"]);
    if (request.method === "PATCH") {
      const payload = await request.json() as Record<string, unknown>;
      const keys = Object.keys(payload);
      assert.ok(keys.length > 0);
      keys.forEach(key => assert.ok(columns.has(key), `unexpected column: ${key}`));
      const values = keys.map(key => key === "classifier_observation" && payload[key] != null ? JSON.stringify(payload[key]) : payload[key]);
      await db.query(`UPDATE genius_question_jobs SET ${keys.map((key, i) => `${key}=$${i + 1}`).join(",")} WHERE message_id=$${keys.length + 1}`, [...values, messageId]);
      writes++;
      return new Response(null, { status: 204 });
    }
    assert.equal(request.method, "GET");
    const projection = url.searchParams.get("select")!.split(",");
    projection.forEach(key => assert.ok(columns.has(key), `unexpected column: ${key}`));
    const result = await db.query(`SELECT ${projection.join(",")} FROM genius_question_jobs WHERE message_id=$1`, [messageId]);
    reads++;
    return new Response(JSON.stringify(result.rows), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const { makeDeps } = await import("../../src/lib/baseball-qa/server");
    await db.exec("INSERT INTO genius_question_jobs (id,message_id,llm_started) VALUES (10,42,true),(11,43,true),(12,44,true)");
    const payload = { text: "persisted-result", inputTokens: 2, outputTokens: 3, classifierObservation: observation };
    await makeDeps(42).storeLlm!(payload);
    const persisted = await db.query<{ classifier_observation: unknown }>("SELECT classifier_observation FROM genius_question_jobs WHERE message_id=42");
    assert.deepEqual(persisted.rows[0].classifier_observation, observation);
    const restored = await makeDeps(42).getLlmState!();
    assert.equal(restored.started, true);
    assert.deepEqual(restored.result, payload);
    // A different job is untouched; legacy results must remain unknown, not false.
    assert.equal((await makeDeps(43).getLlmState!()).result, null);
    await makeDeps(44).storeLlm!({ text: "legacy-result", inputTokens: null, outputTokens: null });
    assert.equal((await makeDeps(44).getLlmState!()).result?.classifierObservation, null);
    assert.equal(writes, 2);
    assert.equal(reads, 3);
  } finally {
    globalThis.fetch = priorFetch;
    for (const key of envKeys) {
      if (priorEnv[key] === undefined) delete process.env[key];
      else process.env[key] = priorEnv[key];
    }
  }
}

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
  // All other fields are valid: this specifically guards failures > calls.
  assert.equal(readClassifierObservation({ ...logs[0].classifierObservation, calls: 1, providerFailures: 2 }), null);
  for (const observation of [undefined, null]) {
    const legacy = buildQuestionLogRow({ ...logEntry, classifierObservation: observation }, 43);
    assert.deepEqual([legacy.stat_intent_mode, legacy.context_selected, legacy.provider_outcome], [null, null, null]);
    assert.equal(legacy.classifier_observation, null);
  }
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

  // Exercise answerQuestion's actual selector-to-observation wiring, never the setter.
  for (const previous of [row, null]) {
    const selected = previous !== null;
    const selectedRun = await evaluateProductionCase({ caseId: `context-${selected}`, question: "오타니 홈런 몇개", userId: "isolated-test" }, () => ({
      ...base, log: async () => {}, storeLlm: undefined, getLlmState: undefined,
      loadPreviousTurn: async () => previous,
      callLlm: async (_question, passedContext) => {
        assert.deepEqual(passedContext ?? null, selected ? context : null);
        return { text: '{"status":"BASEBALL_RULE_TERM","answer":"RECORD"}', inputTokens: 2, outputTokens: 3 };
      },
    }));
    assert.equal(selectedRun.result.source, "stat_clarify");
    assert.ok(selectedRun.logs.length > 0);
    for (const entry of selectedRun.logs) {
      assert.equal(entry.classifierObservation?.contextSelected, selected);
      assert.equal(entry.classifierObservation?.calls, 1);
      assert.equal(buildQuestionLogRow(entry, 44).context_selected, selected);
    }
  }

  const db = new PGlite();
  try {
    await db.exec('CREATE TABLE genius_question_logs (id integer); CREATE TABLE genius_question_jobs (id integer, message_id integer UNIQUE, llm_started boolean DEFAULT false, llm_started_at timestamptz, llm_text text, llm_input_tokens integer, llm_output_tokens integer, updated_at timestamptz); INSERT INTO genius_question_logs VALUES (1);');
    const migration = readFileSync("supabase/migrations/20260922030000_classifier_observation.sql", "utf8");
    await db.exec(migration);
    await db.exec(migration); // additive migration is replay safe
    const old = await db.query('SELECT stat_intent_mode, context_selected, provider_outcome FROM genius_question_logs WHERE id=1');
    assert.deepEqual(old.rows[0], { stat_intent_mode: null, context_selected: null, provider_outcome: null });
    const built = buildQuestionLogRow(logs[0], 42);
    await db.query('INSERT INTO genius_question_logs (id,stat_intent_mode,context_selected,provider_outcome,classifier_observation) VALUES (2,$1,$2,$3,$4)', [built.stat_intent_mode,built.context_selected,built.provider_outcome,JSON.stringify(built.classifier_observation)]);
    const saved = await db.query<{ classifier_observation: unknown }>('SELECT classifier_observation FROM genius_question_logs WHERE id=2');
    assert.deepEqual(readClassifierObservation(saved.rows[0].classifier_observation), logs[0].classifierObservation);
    await verifyProductionJobRoundTrip(db, logs[0].classifierObservation!);

  } finally { await db.close(); }
  console.log("classifier observation: provider/parser/context/replay/log-row/migration contracts PASS");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
