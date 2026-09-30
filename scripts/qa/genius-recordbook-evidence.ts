import assert from "node:assert/strict";
import { answerQuestion, type QaDeps, type LlmResult } from "../../src/lib/baseball-qa/pipeline";
import { buildRagLlmRequest, RAG_OFFICIAL_SYSTEM_PROMPT, validateRagResponse, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";

// Synthetic passages test wiring/guards, not real production record accuracy.
const evidence: RagEvidence[] = [{ sourceGrade: "tier1", sourceKind: "kbo_ebook",
  pageTitle: "2026 KBO 레코드북", content: "오승환 통산 세이브 427개. 레이예스 최다안타 202개.",
  canonicalUrl: "https://www.koreabaseball.com/Reference/Ebook/Ebook.aspx", revision: "qa", sectionPath: "기록", asOf: "2026-09-30" }];
const response = (answer: string, scope = "historical", citation = 1) => JSON.stringify({ status: "GROUNDED", answer,
  recordScope: scope, recordEvidence: citation, calendarClaims: [] });
const validated = (raw: string, rows = evidence) => validateRagResponse(raw, { recordbookRequest: true, numericEvidence: true, evidence: rows });
async function main() {
  assert.equal(validated(response("오승환의 통산 세이브는 427개입니다.")).kind, "grounded");
  for (const raw of [response("427개입니다.", "current"), response("427개입니다.", "unknown"),
    response("427개입니다.", "historical", 0), response("427개입니다.", "historical", 2),
    JSON.stringify({ status: "GENERAL", answer: "427개입니다." })]) assert.equal(validated(raw).kind, "insufficient");
  assert.equal(validated(response("999개입니다.")).kind, "insufficient");
  assert.equal(validated(response("999개입니다."), [...evidence, { ...evidence[0], content: "다른 선수 999개" }]).kind, "insufficient", "cannot borrow numbers from uncited passage");
  assert.equal(validated(response("427개입니다."), [{ ...evidence[0], sourceGrade: "tier2" }]).kind, "insufficient");
  assert.equal(validated(response("427개입니다."), [{ ...evidence[0], pageTitle: "2026 KBO 연감" }]).kind, "insufficient");
  const prompt = buildRagLlmRequest("오승환 통산 기록", evidence, RAG_OFFICIAL_SYSTEM_PROMPT, { recordbookRequest: true });
  assert.match(prompt.systemInstruction.parts[0].text, /발행연도에서 1을 빼지/);
  for (const question of ["오승환 통산 기록", "레이예스 최다안타기록"]) {
    let stored: LlmResult | null = null, started = false, calls = 0;
    const deps: QaDeps = {
      loadGlossary: async () => [],
      enablePlayerRag: true,
      fetchCurrentSeasonRecord: async () => [],
      loadPlayers: async () => [{ name: "오승환", kboId: "qa-oh" }, { name: "레이예스", kboId: "qa-reyes" }],
      reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => {},
      getCache: async () => null, setCache: async () => { throw new Error("must not cache historical records"); },
      callLlm: async () => { throw new Error("must not use general knowledge"); },
      searchOfficialRag: async () => evidence,
      callOfficialRagLlm: async (_q, _e, extras) => {
        calls++; assert.equal(extras?.recordbookRequest, true);
        return { text: response(question.startsWith("오승환") ? "오승환의 통산 세이브는 427개입니다." : "레이예스의 최다안타는 202개입니다."), inputTokens: 5, outputTokens: 4 };
      },
      getLlmState: async () => ({ started, result: stored }),
      acquireLlmStart: async () => { if (started) return false; started = true; return true; },
      storeLlm: async (value) => { stored = value; },
    };
    const result = await answerQuestion("qa-recordbook", question, deps);
    assert.equal(result.source, "rag", question); assert.match(result.answer ?? "", /발행 시점/); assert.equal(calls, 1);
    const replay = await answerQuestion("qa-recordbook", question, deps);
    assert.equal(replay.answer, result.answer); assert.equal(calls, 1);
  }
  console.log("recordbook scope/citation/numeric/durable contracts PASS");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
