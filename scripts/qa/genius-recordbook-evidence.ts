import assert from "node:assert/strict";
import { answerQuestion, type QaDeps, type LlmResult } from "../../src/lib/baseball-qa/pipeline";
import { buildRagLlmRequest, selectRecordbookEvidence, RAG_OFFICIAL_SYSTEM_PROMPT, validateRagResponse, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";

// Synthetic passages test wiring/guards, not real production record accuracy.
const evidence: RagEvidence[] = [{ sourceGrade: "tier1", sourceKind: "kbo_ebook",
  pageTitle: "2026 KBO 레코드북", content: "통산 세이브 순위\n선수명 세이브 안타 연도\n오승환 427 0 2025\n레이예스 0 202 2024",
  canonicalUrl: "https://www.koreabaseball.com/Reference/Ebook/Ebook.aspx", revision: "qa", sectionPath: "기록", asOf: "2026-09-30" }];
const response = (value = "427", scope = "historical", citation = 1, subject = "오승환", label = "세이브") => JSON.stringify({ status: "GROUNDED",
  recordScope: scope, recordEvidence: citation, recordSubject: subject, recordFacts: [{ label, value }] });
const validated = (raw: string, rows = evidence) => validateRagResponse(raw, { recordbookRequest: true, numericEvidence: true, evidence: rows });
async function main() {
  assert.equal(validated(response()).kind, "grounded");
  for (const raw of [response("427", "current"), response("427", "unknown"),
    response("427", "historical", 0), response("427", "historical", 2),
    JSON.stringify({ status: "GENERAL", answer: "427개입니다." }),
    JSON.stringify({ status: "GROUNDED", answer: "사십이십칠 세이브입니다.", recordScope: "historical", recordEvidence: 1 })]) {
    assert.equal(validated(raw).kind, "insufficient");
  }
  for (const value of ["999", "사십이십칠", "사십이십칠 세이브", "사백이십칠 세이브", "이천이십사년에 이백이안타 일위"]) {
    assert.equal(validated(response(value)).kind, "insufficient", value);
    // Even source-surface reuse must not serve malformed/Hangul-number output.
    assert.equal(validated(response(value), [{ ...evidence[0], content: evidence[0].content + "\n" + value }]).kind,
      value === "999" ? "grounded" : "insufficient", value);
  }
  assert.equal(validated(response("999"), [...evidence, { ...evidence[0], content: "다른 선수 999" }]).kind, "insufficient", "cannot borrow numbers from uncited passage");
  assert.equal(validated(response(), [{ ...evidence[0], sourceGrade: "tier2" }]).kind, "insufficient");
  assert.equal(validated(response(), [{ ...evidence[0], pageTitle: "2026 KBO 연감" }]).kind, "insufficient");
  assert.equal(validated(response("202", "historical", 1, "레이예스", "안타")).kind, "grounded");
  const selected = selectRecordbookEvidence([{ ...evidence[0], pageTitle: "2015 KBO 기록대백과" },
    { ...evidence[0], content: "표 설명 ".repeat(170) + "\n오승환 427" }]);
  assert.equal(selected[0].pageTitle, "2026 KBO 레코드북");
  assert.match(selected[0].content, /오승환 427$/);
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
        return { text: (question.startsWith("오승환") ? response() : response("202", "historical", 1, "레이예스", "안타")), inputTokens: 5, outputTokens: 4 };
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
