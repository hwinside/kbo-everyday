/** Reviewer-owned execution. Synthetic rows/provider only; no DB or DM writes.
 * --live --base-root=... --out=... uses each ref's production pipeline+provider.
 * The first turn's actual stored envelope feeds the exact-row adapter for turn 2.
 * Do NOT inject a pre-qualified ContextTurn: that hid the #1591 production bug.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { answerQuestion, unpackStoredQaFinal, packStoredQaFinal, type QaDeps, type LlmResult } from "../../src/lib/baseball-qa/pipeline";
import { previousTurnFromSql } from "../../src/lib/baseball-qa/previous-turn-row";
import { selectAppFactContextTurn, selectContextTurn, selectDraftContextTurn, type PreviousTurnRow } from "../../src/lib/baseball-qa/context";
import { renderAppFacts } from "../../src/lib/baseball-qa/app-fact-conversation";
import type { GameConversationInput } from "../../src/lib/baseball-qa/game-conversation";

const now = Date.parse("2026-11-02T02:30:00Z");
const firstQuestion = "키움 메이저리거 선수들이 돌아오면 몇등임";
const cases = [
  { id: "qa-3242998", next: "그러면 몇 등일까?", kind: "scenario" },
  { id: "qa-3243004", next: "가정 말고 실제 지금 순위는?", kind: "actual" },
  { id: "paraphrase", next: "그 전력이면 성적이 어떻게 될까?", kind: "scenario" },
  { id: "explicit-other-team", next: "실제 삼성 순위는?", kind: "samsung" },
  { id: "explicit-all-teams", next: "가정 말고 전체 구단 실제 순위는?", kind: "all" },
  { id: "new-rule", next: "한화가 와일드카드에서 지면 어떻게 돼?", kind: "rule" },
] as const;
const snapshot = { favoriteTeam: null, games: [], appFacts: {
  tomorrow: { date: "2026-11-03", games: [] }, standings: { season: 2026, fetchedAt: new Date(now).toISOString(), rows: [
    { teamId: 10, teamName: "키움", games: 144, wins: 50, losses: 90, draws: 4, ranking: 10, winRate: .357, gamesBehind: 30 },
    { teamId: 2, teamName: "삼성", games: 144, wins: 83, losses: 58, draws: 3, ranking: 2, winRate: .589, gamesBehind: 8 },
  ] },
} };
function selected(i: GameConversationInput, scenario: boolean) {
  const source = i.question === firstQuestion ? "question" : i.context ? "context_question" : "none";
  const quote = source === "question" ? i.question : source === "context_question" ? i.context!.question : "";
  return { action: "app_facts", evidenceSource: "none", attendanceEvidence: "",
    appRequest: { scenarioRelation: i.context ? scenario ? "continue_scenario" : "actual_same_team" : "none", informationNeed: scenario ? "scenario_outcome" : "team_standing", kind: scenario ? "none" : "standings",
      period: scenario ? "unsupported" : "current", quote: i.question, intentSource: scenario && source === "context_question" ? "context_question" : "question",
      intentQuote: scenario && source === "context_question" ? i.context!.question : i.question },
    target: { source, quote, teams: source === "none" ? [] : ["키움"], excludedTeams: [], backgroundTeams: [], stadium: "", excludedStadiums: [],
      mentions: i.teamCandidates?.filter(c => c.source === source && c.canonical === "키움").map(c => ({ id: c.id, referent: "baseball_team", role: "target" })) ?? [] } };
}
function sqlRow(question: string, answer: string, source: string, stored: LlmResult | null) {
  return { question, answer, job_source: source, definition_llm_text: stored?.text,
    answered_at: new Date(now - 1000).toISOString(), current_created_at: new Date(now).toISOString() };
}
async function sequence(api: { answerQuestion: typeof answerQuestion; previousTurnFromSql: typeof previousTurnFromSql }, next: string,
  provider?: (i: GameConversationInput) => Promise<LlmResult>) {
  let previous: PreviousTurnRow | null = null;
  const turns: Record<string, unknown>[] = [];
  for (const question of [firstQuestion, next]) {
    let stored: LlmResult | null = null, started = false;
    const trace: Record<string, unknown>[] = []; const startedAt = Date.now();
    const event = (stage: string) => trace.push({ stage, elapsedMs: Date.now() - startedAt });
    let seen: GameConversationInput | undefined; let value: Record<string, unknown> | undefined;
    const deps: QaDeps = {
      loadGlossary: async () => [], loadPlayers: async () => [], getCache: async () => null,
      setCache: async () => { throw new Error("shared-cache write forbidden"); },
      reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => {}, now: () => now,
      getLlmState: async () => ({ started, result: stored }), acquireLlmStart: async () => { started = true; return true; }, storeLlm: async result => { stored = result; },
      loadPreviousTurn: async () => previous, loadGameConversation: async () => snapshot,
      callGameConversation: async i => {
        seen = i; event("app_provider_start");
        const start = Date.now();
        let result: LlmResult;
        try { result = provider ? await provider(i).then(r => { event("app_provider_resolved"); return r; }, e => { event("app_provider_rejected"); throw e; }) : { text: JSON.stringify(selected(i, question === firstQuestion || Boolean(i.context) && next === cases[0].next)), inputTokens: 1, outputTokens: 1 };
        trace.push({ stage: "app-provider-result", elapsedMs: Date.now() - start, text: result.text });
        } catch (error) { trace.push({ stage: "app-provider-error", elapsedMs: Date.now() - start, error: String(error) }); throw error; }
        value = JSON.parse(result.text); return result;
      },
      callLlm: async () => {
        trace.push({ stage: "synthetic-generic-fallback", elapsedMs: Date.now() - startedAt, note: "NOT_BASEBALL fixture, not production classifier evidence" });
        return { text: JSON.stringify({ status: "NOT_BASEBALL" }), inputTokens: 0, outputTokens: 0 };
      },
    };
    const result = await api.answerQuestion("qa-scenario-synthetic", question, deps);
    const row = sqlRow(question, result.answer, result.source, stored);
    previous = api.previousTurnFromSql(row);
    event("final_" + result.source);
    turns.push({ question, result, stored, input: seen, value, trace });
  }
  return turns;
}
function assess(turns: Record<string, unknown>[], kind: string) {
  const second = turns[1] as any;
  assert.ok(second.input, "second turn must reach app-fact interpreter");
  assert.equal(second.input.context?.question, firstQuestion, "real stored first turn must supply scenario topic");
  assert.doesNotMatch(second.input.context.answer, /10위|50승|앱 순위표/, "reference facts are not inherited");
  const need = second.value?.appRequest?.informationNeed;
  if (kind === "scenario") { assert.equal(need, "scenario_outcome"); assert.match(second.result.answer, /선수 구성 변화/); }
  if (kind === "actual") { assert.equal(need, "team_standing"); assert.match(second.result.answer, /키움/); assert.doesNotMatch(second.result.answer, /삼성|선수 구성 변화/); }
  if (kind === "samsung") { assert.equal(need, "team_standing"); assert.match(second.result.answer, /삼성/); assert.doesNotMatch(second.result.answer, /키움|선수 구성 변화/); }
  if (kind === "all") { assert.equal(need, "team_standing"); assert.match(second.result.answer, /키움/); assert.match(second.result.answer, /삼성/); assert.doesNotMatch(second.result.answer, /선수 구성 변화/); }
  if (kind === "rule") assert.notEqual(second.value.action, "app_facts", "rule must not inherit scenario classification");
}
async function main() {
  const api = { answerQuestion, previousTurnFromSql };
  const turns = await sequence(api, cases[0].next); assess(turns, "scenario");
  assess(await sequence(api, cases[1].next), "actual");
  // Model drops target on an actual transition: relation must bind resolver teams.
  const secondInput = (turns[1] as any).input as GameConversationInput;
  const actualInput = { ...secondInput, question: cases[1].next };
  const actual = selected(actualInput, false);
  actual.target = { ...actual.target, source: "none", quote: "", teams: [], mentions: [] };
  assert.match(renderAppFacts(actual, actualInput)!.answer, /키움/);
  assert.doesNotMatch(renderAppFacts(actual, actualInput)!.answer, /삼성/);
  const allInput = { ...actualInput, question: "가정 말고 전체 구단 실제 순위는?" };
  const all = { ...actual, appRequest: { ...actual.appRequest, quote: allInput.question, intentQuote: allInput.question, scenarioRelation: "new_topic" } };
  assert.match(renderAppFacts(all, allInput)!.answer, /삼성/, "explicit all/new-topic does not inherit team");
  const otherInput = { ...actualInput, question: cases[3].next,
    teamNames: { ...actualInput.teamNames, question: ["삼성"] }, teamCandidates: [] };
  const other = selected(otherInput, false);
  other.target = { ...other.target, source: "question", quote: otherInput.question, teams: ["삼성"], mentions: [] };
  assert.match(renderAppFacts(other, otherInput)!.answer, /삼성/);
  assert.doesNotMatch(renderAppFacts(other, otherInput)!.answer, /키움/);
  const rejected = await sequence(api, cases[0].next, async i => {
    if (i.context) throw new Error("synthetic provider failure");
    return { text: JSON.stringify(selected(i, true)), inputTokens: 1, outputTokens: 1 };
  });
  assert.equal((rejected[1] as any).result.source, "error", "provider failure is not NOT_BASEBALL");
  const first = turns[0] as any;
  const row = sqlRow(firstQuestion, first.result.answer, first.result.source, first.stored);
  const parsed = previousTurnFromSql(row)!;
  assert.ok(selectAppFactContextTurn(parsed));
  assert.equal(selectContextTurn(parsed), null); assert.equal(selectDraftContextTurn(parsed), null);
  const invalid = [ { ...parsed, scenarioContext: undefined }, { ...parsed, scenarioContext: { version: 2, question: firstQuestion } },
    { ...parsed, scenarioContext: { version: 1, question: "" } }, { ...parsed, jobSource: "blocked" }, { ...parsed, answer: null },
    { ...parsed, answeredAt: null }, { ...parsed, answeredAt: new Date(now).toISOString() },
    { ...parsed, answeredAt: new Date(now - 600001).toISOString() } ];
  for (const bad of invalid) assert.equal(selectAppFactContextTurn(bad), null);
  assert.ok(selectAppFactContextTurn({ ...parsed, answeredAt: new Date(now - 600000).toISOString() }));
  assert.equal(selectAppFactContextTurn(previousTurnFromSql({ ...row, answer: "different delivered answer" })), null);
  assert.equal(selectAppFactContextTurn(previousTurnFromSql({ ...row, job_source: "error" })), null);
  const final = unpackStoredQaFinal(first.stored.text)!;
  assert.deepEqual(unpackStoredQaFinal(packStoredQaFinal(final, first.stored).text), final);
  console.log(JSON.stringify({ mode: "offline", twoTurn: "PASS", boundaries: "PASS", genericHistoryHold: "CLOSED" }));
  if (!process.argv.includes("--live")) return;
  const arg = (n: string) => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  assert.ok(arg("base-root") && arg("out"));
  const records: unknown[] = []; let failures = 0;
  for (const [variant, root] of [["base", arg("base-root")!], ["head", path.resolve(import.meta.dirname, "../..")]]) {
    const pipeline = await import(pathToFileURL(path.join(root, "src/lib/baseball-qa/pipeline.ts")).href);
    const adapter = await import(pathToFileURL(path.join(root, "src/lib/baseball-qa/previous-turn-row.ts")).href);
    const server = await import(pathToFileURL(path.join(root, "src/lib/baseball-qa/server.ts")).href);
    for (const c of cases) for (let repeat = 0; repeat < 3; repeat++) {
      let turns: Record<string, unknown>[] = [];
      const record: any = { variant, id: c.id, repeat };
      try { turns = await sequence({ ...pipeline, ...adapter }, c.next, server.callGameConversation); assess(turns, c.kind); record.pass = true; }
      catch (error) { record.pass = false; record.error = String(error); const second = turns[1] as any;
        const known = c.id === "explicit-other-team" && !second?.input && second?.result?.source === "history_hold"
          && second.result.answer.startsWith("팀 단위 기록(");
        record.knownFail = known ? "pre-existing team_record terminal hold (not app interpreter)" : null;
        if (variant === "head" && !known) failures++; }
      records.push({ ...record, turns }); fs.writeFileSync(arg("out")!, JSON.stringify(records, null, 2));
    }
  }
  console.log(JSON.stringify({ mode: "live", sequences: records.length, headFailures: failures }));
  assert.equal(failures, 0);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
