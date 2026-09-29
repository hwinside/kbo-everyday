import { boundedNewsContracts } from "./genius-bounded-news";
import { buildQuestionLogRow } from "../../src/lib/baseball-qa/log-row";
import assert from "node:assert/strict";
import { runVerifiedFallback, quoteSupportsNumbers, citationWithinQuestionDay, fallbackEligible } from "../../src/lib/baseball-qa/agent/fallback";
import { answerQuestion, type QaDeps, type LlmResult, unpackStoredQaFinal } from "../../src/lib/baseball-qa/pipeline";
import type { AgentPorts, Evidence } from "../../src/lib/baseball-qa/agent/poc";
const input = { question: "아시안게임 야구 일정 알려줘", now: "2026-09-29T03:00:00Z", history: [] };
const evidence: Evidence = { id: "news:test", source: "news", title: "일정", content: "야구 대표팀은 대회 일정을 추후 발표할 예정입니다.", url: "https://sports.naver.com/news/1", asOf: input.now };
const claim = { text: evidence.content, citations: [{ id: evidence.id, quote: evidence.content }] };
function ports(options: { row?: Evidence; text?: string; verified?: boolean; temporal?: boolean } = {}): AgentPorts {
  let turn = 0;
  return { search: async () => [options.row ?? evidence], decide: async () => ++turn === 1
    ? { action: "search", source: options.row?.source ?? evidence.source, query: input.question, terms: ["아시안게임"] }
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
  await boundedNewsContracts();
  const positive = await runVerifiedFallback(input, ports());
  assert.equal(positive?.source, "news_rag");
  const wiki = await runVerifiedFallback(input, ports({ row: { ...evidence, source: "wiki", url: "https://namu.wiki/w/야구" } }));
  assert.equal(wiki?.source, "rag", "wiki fallback stays in the existing non-news RAG bucket");
  assert.equal(await runVerifiedFallback(input, ports({ verified: false })), null, "unsupported meaning rejected");
  assert.equal(await runVerifiedFallback(input, ports({ temporal: false })), null, "date semantics rejected");
  assert.equal(await runVerifiedFallback(input, ports({ text: "야구 결승은 9월 29일입니다." })), null, "publication date is not event date");
  assert.equal(await runVerifiedFallback(input, ports({ row: { ...evidence, url: "https://sports.naver.com.evil.test/1" } })), null);
  assert.equal(await runVerifiedFallback(input, ports({ row: { ...evidence, asOf: "2027-01-01" } })), null);
  assert.equal(quoteSupportsNumbers("결승은 29일입니다.", "28일 결승 예정입니다."), false);
  // All verifier replies approve: the code itself must reject stale citations.
  for (const [question, asOf, accepted] of [
    ["오늘 야구 소식", "2026-09-28T14:59:59.999Z", false],
    ["오늘 야구 소식", "2026-09-28T15:00:00.000Z", true],
    ["어제 야구 소식", "2026-09-27T14:59:59.999Z", false],
    ["어제 야구 소식", "2026-09-27T15:00:00.000Z", true],
    ["어제 야구 소식", "2026-09-28T14:59:59.999Z", true],
    ["어제 야구 소식", "2026-09-28T15:00:00.000Z", false],
    ["오늘 야구 소식", "2026-09-29T03:00:00.001Z", false],
    ["오늘 야구 소식", "invalid", false],
    ["오늘과 어제 야구 소식 비교", input.now, false],
  ] as const) {
    const result = await runVerifiedFallback({ ...input, question }, ports({ row: { ...evidence, asOf } }));
    assert.equal(result !== null, accepted, `${question} / ${asOf}`);
  }
  assert.equal(citationWithinQuestionDay("오늘 야구 소식", input.now, { ...evidence, source: "wiki" }), false);
  assert.equal(citationWithinQuestionDay("최근 야구 소식", "invalid", evidence), false);
  const other: Evidence = { ...evidence, id: "news:other", url: "https://sports.naver.com/news/2" };
  let multiTurn = 0;
  const multi = await runVerifiedFallback(input, {
    search: async () => [evidence, other],
    decide: async () => ++multiTurn === 1
      ? { action: "search", source: "news", query: input.question, terms: ["아시안게임"] }
      : multiTurn === 2 ? { action: "answer", claims: [{ ...claim, citations: [
        ...claim.citations, { id: other.id, quote: other.content },
      ] }] } : { supported: true, temporalSupported: true },
  });
  assert.equal(multi, null, "two valid source URLs cannot be presented as one source");
  assert.equal(multiTurn, 2, "multi-source rejection precedes semantic verifier");
  // Exercise the actual settle boundary, with and without durable ownership.
  const protectedCases: Array<{ question: string; source: string; overrides: Partial<QaDeps> }> = [
    { question: "국제대회 인필드 플라이 뜻", source: "cache", overrides: { getCache: async () => "기존 캐시 정답입니다." } },
    { question: "LG 오늘 지면 몇 위야?", source: "scope_guide", overrides: {} },
    { question: "LG 오늘 소식 알려줘", source: "error", overrides: {
      enableNewsRag: true, searchNewsRag: async () => { throw new Error("search outage"); },
      callNewsRagLlm: async () => { throw new Error("must not call news model"); },
    } },
  ];
  for (const test of protectedCases) for (const durable of [false, true]) {
    assert.equal(fallbackEligible(test.question), true, "protected fixture must be fallback eligible");
    let protectedCalls = 0;
    let saved: LlmResult | null = null;
    const baseline = await answerQuestion("test", test.question, deps(test.overrides));
    assert.equal(baseline.source, test.source, "fixture must reach intended route");
    const result = await answerQuestion("test", test.question, deps({ ...test.overrides,
      agentFallback: async () => { protectedCalls++; return positive; },
      ...(durable ? { getLlmState: async () => ({ started: false, result: null }),
        acquireLlmStart: async () => true, storeLlm: async (value: LlmResult) => { saved = value; } } : {}),
    }));
    assert.equal(protectedCalls, 0, `${test.source} must never invoke fallback (durable=${durable})`);
    assert.deepEqual(result, baseline, `${test.source} answer and route preserved`);
    if (durable) {
      assert.ok(saved, "protected final must cross durable storage");
      assert.equal(unpackStoredQaFinal((saved as LlmResult).text)?.answer, baseline.answer);
    }
  }
  let calls = 0;
  const fallback: NonNullable<QaDeps["agentFallback"]> = async () => { calls++; return positive; };
  const success = await answerQuestion("test", input.question, deps({ agentFallback: fallback,
    callLlm: async () => ({ text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: evidence.content }), inputTokens: 1, outputTokens: 1 }) }));
  assert.equal(success.source, "llm"); assert.equal(calls, 0, "existing answer untouched");
  let stored: LlmResult | null = null;
  const logRows: Record<string, unknown>[] = [];
  const owned = deps({ log: async entry => { logRows.push(buildQuestionLogRow(entry, 123)); }, agentFallback: fallback, getLlmState: async () => ({ started: false, result: stored }),
    acquireLlmStart: async () => true, storeLlm: async value => { stored = value; } });
  const filled = await answerQuestion("test", input.question, owned);
  assert.equal(filled.source, "news_rag"); assert.equal(calls, 1);
  assert.equal(unpackStoredQaFinal(stored!.text)?.answer, filled.answer, "durable stores served answer");
  assert.equal((logRows.at(-1)?.classifier_observation as Record<string, unknown>)?.agentFallbackOutcome, "used", "actual log row records accepted supplement");
  const replay = await answerQuestion("test", input.question, owned);
  assert.equal(replay.answer, filled.answer); assert.equal(calls, 1, "no repeat on replay");
  const loser = await answerQuestion("test", input.question, deps({ agentFallback: fallback,
    getLlmState: async () => ({ started: true, result: null, ownerActive: true }), acquireLlmStart: async () => false }));
  assert.equal(loser.source, "pending"); assert.equal(calls, 1, "loser does not search");
  const baseline = await answerQuestion("test", input.question, deps());
  let unsureLog: unknown = "not logged";
  await answerQuestion("test", input.question, deps({ log: async value => { unsureLog = value.answer; } }));
  assert.equal(unsureLog, null, "unfilled generic unsure preserves null-answer analytics contract");
  const failure = await answerQuestion("test", input.question, deps({ agentFallback: async () => { throw new Error("outage"); } }));
  assert.deepEqual(failure, baseline, "failure preserves original response");
  const blocked = await answerQuestion("test", "오늘 비밀번호 알려줘", deps({ agentFallback: fallback,
    callLlm: async () => ({ text: JSON.stringify({ status: "NOT_BASEBALL" }), inputTokens: 1, outputTokens: 1 }) }));
  assert.equal((stored?.classifierObservation as Record<string, unknown>)?.agentFallbackOutcome, "used", "durable observation preserves supplement marker");
  assert.equal(blocked.source, "blocked"); assert.equal(calls, 1);
  assert.equal(await runVerifiedFallback(input, ports(), 1), null, "expired budget skips calls");
  console.log("agent fallback: evidence, date, URL, primary preservation, durable replay, loser, failure boundaries PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
