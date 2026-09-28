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
