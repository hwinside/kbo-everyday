import assert from "node:assert/strict";
import { runAgentPoc, validateClaims, type AgentPorts, type Evidence } from "../../src/lib/baseball-qa/agent/poc";

const input = { question: "그럼 야구는 언제야?", now: "2026-09-28T05:00:00Z",
  history: [{ question: "아시안게임 알려줘", answer: "일정을 확인해 볼게요." }] };
const evidence: Evidence = { id: "news:fixture", source: "news", title: "테스트 자료", content: "이 문장은 출처 연결 검증 전용 가상 자료입니다.", url: "https://example.com/fixture", asOf: input.now };
const claims = [{ text: "출처 연결 검증 전용 가상 자료입니다.", citations: [{ id: evidence.id, quote: evidence.content }] }];
const search = { action: "search", source: "news", query: "아시안게임 야구 일정", terms: ["아시안게임"] };
function ports(actions: unknown[], lookup: AgentPorts["search"] = async () => [evidence]): AgentPorts {
  return { decide: async (_system, state) => {
    assert.deepEqual((state as typeof input).history, input.history);
    return actions.shift();
  }, search: lookup };
}
async function main() {
  const ok = await runAgentPoc(input, ports([search, { action: "answer", claims }]));
  assert.equal(ok.status, "answered");
  assert.equal(ok.trace[0].outcome, "found");
  assert.equal(ok.modelCalls, 2);
  assert.equal(validateClaims([{ ...claims[0], citations: [{ id: "invented", quote: evidence.content }] }], [evidence]), null);
  assert.equal(validateClaims([{ ...claims[0], citations: [{ id: evidence.id, quote: "존재하지 않는 내용으로 바꾸었습니다." }] }], [evidence]), null);
  assert.equal((await runAgentPoc(input, ports([{ action: "answer", claims }]))).status, "error");
  assert.equal((await runAgentPoc(input, ports([{ ...search, source: "shell" }]))).reason, "invalid_action");
  const empty = await runAgentPoc(input, ports([search, { action: "insufficient", reason: "일정 근거 없음" }], async () => []));
  assert.equal(empty.trace[0].outcome, "empty");
  const failed = await runAgentPoc(input, ports([search, { action: "insufficient", reason: "검색 장애" }], async () => { throw new Error("secret sentinel"); }));
  assert.equal(failed.trace[0].outcome, "error");
  assert.ok(!JSON.stringify(failed).includes("secret sentinel"));
  assert.equal((await runAgentPoc(input, ports([search, search]))).reason, "repeated_search");
  const budget = await runAgentPoc(input, ports([1,2,3,4].map(n => ({ ...search, query: `query ${n}` }))));
  assert.equal(budget.trace.length, 3);
  assert.equal(budget.reason, "search_budget_exhausted");
  assert.equal((await runAgentPoc({ ...input, now: "invalid" }, ports([]))).reason, "invalid_input");
  const wrongSource = await runAgentPoc(input, ports([search, { action: "answer", claims }], async () => [{ ...evidence, source: "wiki" }]));
  assert.equal(wrongSource.status, "error");
  console.log("agent PoC boundaries PASS; semantic quality and live adapters NOT verified");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

// Adapter regression fixtures: future top-k starvation and document monopolization.
import { newsPageParams, rankNews, searchWiki } from "../baseball-qa/agent/search-adapters";
async function adapterRegressions() {
  for (const day of ["2026-09-11", "2026-09-12"]) {
    const now = `${day}T12:00:00Z`;
    const params = newsPageParams(now, 0);
    assert.ok(params.getAll("published_at").includes(`lte.${now}`));
    assert.equal(params.get("collected_at"), `lte.${now}`);
    assert.equal(params.get("embedded_at"), `lte.${now}`);
    const future = Array.from({ length: 12 }, (_, i) => ({ article_key: `future${i}`, published_at: "2026-09-27T00:00:00Z", embedding: [1, 0] }));
    const past = { article_key: "past", published_at: "2026-09-10T00:00:00Z", embedding: [0.9, 0.1] };
    assert.deepEqual(rankNews([...future, past], [1, 0], now), [past]);
  }
  let calls = 0;
  const rows = await searchWiki(["야구", "아시안게임"], input.now, new AbortController().signal, async (_table, params) => {
    assert.notEqual(params.get("page_title"), "ilike.*야구*");
    const i = calls++;
    if (i) assert.ok(params.getAll("source_key").includes('neq."doc0"'));
    return [0, 1].map(chunk => ({ source_key: `doc${i}`, page_title: `대회${i}`, content: `근거 ${i}-${chunk}`, canonical_url: "https://example.com", as_of: "2026-09-01" }));
  });
  assert.equal(calls, 3);
  assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map(row => row.title)).size, 3);
  assert.equal((await searchWiki(["야구", "선수"], input.now, new AbortController().signal, async () => { throw new Error("generic query must not run"); })).length, 0);
}
adapterRegressions().catch(error => { console.error(error); process.exitCode = 1; });
