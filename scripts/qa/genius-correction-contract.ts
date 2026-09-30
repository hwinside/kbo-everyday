/** Independent reviewer executes this offline provider-boundary contract test.
 * It verifies wiring/provenance, not the model's semantic decision accuracy. */
import assert from "node:assert/strict";
import { TEAM_CORRECTION_RESPONSE_SCHEMA, VERIFIED_CORRECTION_ACK } from "../../src/lib/baseball-qa/rag/correction";
import { validateRagResponse, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";

const evidence: RagEvidence[] = [{ pageTitle: "구단 소개", sectionPath: "홈구장", canonicalUrl: "https://namu.wiki/w/두산", revision: "test", asOf: "2026-09-30", sourceGrade: "tier2", content: "두산은 잠실야구장을 홈구장으로 사용합니다." }];
const context = { question: "두산 홈구장은?", answer: "두산은 사직야구장을 홈구장으로 사용합니다." };
const answer = "두산은 잠실야구장을 홈구장으로 사용합니다.";
const none = { status: "GROUNDED", answer, correction: "none", previousClaim: "", correctionEvidence: [] };
const verified = { ...none, correction: "previous_answer_wrong", previousClaim: context.answer, correctionEvidence: [{ evidence: 1, quote: evidence[0].content }] };

async function main() {
  process.env.GEMINI_API_KEY ||= "offline-test";
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "offline-test";
  const { callTeamRagLlm } = await import("../../src/lib/baseball-qa/server");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let response: unknown = none;
  globalThis.fetch = async (_input, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.generationConfig.responseSchema, TEAM_CORRECTION_RESPONSE_SCHEMA);
    assert.match(request.systemInstruction.parts[0].text, /previous_answer_wrong/);
    assert.doesNotMatch(request.systemInstruction.parts[0].text, /지적 감사합니다\. 제가 실책했습니다/);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(response) }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 } }), { status: 200 });
  };
  const invoke = async (row: unknown, previous: typeof context | null = context) => {
    response = row;
    const before = calls;
    const result = await callTeamRagLlm("두산 홈구장은 잠실 아니야?", evidence, { context: previous ?? undefined });
    assert.equal(calls - before, 1, "no second model call");
    assert.equal(result.inputTokens, 3);
    return { raw: JSON.parse(result.text), validated: validateRagResponse(result.text) };
  };
  try {
    const corrected = await invoke(verified);
    assert.equal(corrected.raw.answer, `${VERIFIED_CORRECTION_ACK} ${answer}`);
    assert.equal(corrected.raw.factualAnswer, answer);
    assert.equal(corrected.validated.kind, "grounded");
    for (const row of [none, { ...none, correction: "user_claim_unsupported" }]) {
      const result = await invoke(row);
      assert.equal(result.raw.answer, answer);
      assert.equal(result.validated.kind, "grounded", "correct factual answer preserved");
    }
    const invalid = [
      { status: "GROUNDED", answer },
      { ...verified, correction: "arbitrary" },
      { ...verified, previousClaim: "사용자가 한 주장" },
      { ...verified, correctionEvidence: [] },
      { ...verified, correctionEvidence: [{ evidence: "1", quote: evidence[0].content }] },
      { ...verified, correctionEvidence: [{ evidence: 2, quote: evidence[0].content }] },
      { ...verified, correctionEvidence: [{ evidence: 1, quote: "자료에 없는 문장" }] },
    ];
    for (const row of invalid) assert.equal((await invoke(row)).validated.kind, "insufficient");
    assert.equal((await invoke(verified, null)).validated.kind, "insufficient");
    assert.equal((await invoke({ ...verified, status: "INSUFFICIENT", answer: "" })).validated.kind, "insufficient");
    assert.equal((await invoke({ ...verified, answer: "두산은 99회 우승했습니다." })).validated.kind, "insufficient", "normal numeric guard remains enforced after rendering");
    console.log(`correction provider boundary: ${calls} cases passed (semantic replay still required)`);
  } finally { globalThis.fetch = originalFetch; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
