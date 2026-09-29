import assert from "node:assert/strict";
import { runVerifiedFallback, quoteSupportsNumbers } from "../../src/lib/baseball-qa/agent/fallback";
import { answerQuestion, type QaDeps, type LlmResult, unpackStoredQaFinal } from "../../src/lib/baseball-qa/pipeline";
import type { AgentPorts, Evidence } from "../../src/lib/baseball-qa/agent/poc";
const input = { question: "아시안게임 야구 일정 알려줘", now: "2026-09-29T03:00:00Z", history: [] };
const evidence: Evidence = { id: "news:test", source: "news", title: "일정", content: "야구 대표팀은 대회 일정을 추후 발표할 예정입니다.", url: "https://sports.naver.com/news/1", asOf: input.now };
const claim = { text: evidence.content, citations: [{ id: evidence.id, quote: evidence.content }] };
function ports(options: { row?: Evidence; text?: string; verified?: boolean; temporal?: boolean } = {}): AgentPorts {
  let turn = 0;
  return { search: async () => [options.row ?? evidence], decide: async () => ++turn === 1
    ? { action: "search", source: "news", query: input.question, terms: ["아시안게임"] }
    : turn === 2 ? { action: "answer", claims: [{ ...claim, text: options.text ?? claim.text }] }
    : { supported: options.verified ?? true, temporalSupported: options.temporal ?? true } };
}
function deps(overrides: Partial<QaDeps> = {}): QaDeps {
  return { loadGlossary: async () => [], loadPlayers: async () => [], getCache: async () => null,
    setCache: async () => { throw new Error("fallback must not cache"); },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => {},
    now: () => Date.parse(input.now),
    callLlm: async () => ({ text: JSON.stringify({ status: "UNSURE" }), inputTokens: 1, outputTokens: 1 }), ...overrides };
}
async function main() {
  const positive = await runVerifiedFallback(input, ports());
  assert.equal(positive?.source, "news_rag");
  assert.equal(await runVerifiedFallback(input, ports({ verified: false })), null, "unsupported meaning rejected");
  assert.equal(await runVerifiedFallback(input, ports({ temporal: false })), null, "date semantics rejected");
  assert.equal(await runVerifiedFallback(input, ports({ text: "야구 결승은 9월 29일입니다." })), null, "publication date is not event date");
  assert.equal(await runVerifiedFallback(input, ports({ row: { ...evidence, url: "https://sports.naver.com.evil.test/1" } })), null);
  assert.equal(await runVerifiedFallback(input, ports({ row: { ...evidence, asOf: "2027-01-01" } })), null);
  assert.equal(quoteSupportsNumbers("결승은 29일입니다.", "28일 결승 예정입니다."), false);
  let calls = 0;
  const fallback: NonNullable<QaDeps["agentFallback"]> = async () => { calls++; return positive; };
  const success = await answerQuestion("test", input.question, deps({ agentFallback: fallback,
    callLlm: async () => ({ text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: evidence.content }), inputTokens: 1, outputTokens: 1 }) }));
  assert.equal(success.source, "llm"); assert.equal(calls, 0, "existing answer untouched");
  let stored: LlmResult | null = null;
  const owned = deps({ agentFallback: fallback, getLlmState: async () => ({ started: false, result: stored }),
    acquireLlmStart: async () => true, storeLlm: async value => { stored = value; } });
  const filled = await answerQuestion("test", input.question, owned);
  assert.equal(filled.source, "news_rag"); assert.equal(calls, 1);
  assert.equal(unpackStoredQaFinal(stored!.text)?.answer, filled.answer, "durable stores served answer");
  const replay = await answerQuestion("test", input.question, owned);
  assert.equal(replay.answer, filled.answer); assert.equal(calls, 1, "no repeat on replay");
  const loser = await answerQuestion("test", input.question, deps({ agentFallback: fallback,
    getLlmState: async () => ({ started: true, result: null, ownerActive: true }), acquireLlmStart: async () => false }));
  assert.equal(loser.source, "pending"); assert.equal(calls, 1, "loser does not search");
  const baseline = await answerQuestion("test", input.question, deps());
  const failure = await answerQuestion("test", input.question, deps({ agentFallback: async () => { throw new Error("outage"); } }));
  assert.deepEqual(failure, baseline, "failure preserves original response");
  const blocked = await answerQuestion("test", "오늘 비밀번호 알려줘", deps({ agentFallback: fallback,
    callLlm: async () => ({ text: JSON.stringify({ status: "NOT_BASEBALL" }), inputTokens: 1, outputTokens: 1 }) }));
  assert.equal(blocked.source, "blocked"); assert.equal(calls, 1);
  assert.equal(await runVerifiedFallback(input, ports(), 1), null, "expired budget skips calls");
  console.log("agent fallback: evidence, date, URL, primary preservation, durable replay, loser, failure boundaries PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
