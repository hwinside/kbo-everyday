/** Reviewer-run: real pipeline validation, final storage and retry replay. No network. */
import assert from "node:assert/strict";
import { answerQuestion, unpackStoredQaFinal, type QaDeps, type LlmResult } from "../../src/lib/baseball-qa/pipeline";
import { RAG_DISCARD_REASONS, validateRagResponse, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";
import { renderRagHold, RAG_DATE_HOLD, RAG_NUMBER_HOLD, RAG_NEUTRAL_HOLD, RAG_RESPONSE_HOLD } from "../../src/lib/baseball-qa/rag/hold-answer";

const official: RagEvidence = { content: "2025년 포스트시즌은 10월 6일 시작했다.", pageTitle: "연감", sectionPath: "포스트시즌",
  canonicalUrl: "https://www.koreabaseball.com/kbo/board/ebook/ebookpublication.aspx", revision: "fixture", asOf: "2026-09-30", sourceGrade: "tier1",
  calendarSeason: { season: 2025, axis: "calendar_event", heading: "2025 포스트시즌", headingPage: 1, pageTextSha256: "a".repeat(64), sourcePdfSha256: "b".repeat(64) } };
const team: RagEvidence = { ...official, content: "두산 베어스는 서울종합운동장 야구장을 홈구장으로 사용한다.", pageTitle: "두산 베어스", sectionPath: "홈구장",
  canonicalUrl: "https://namu.wiki/w/두산%20베어스", sourceGrade: "tier2", calendarSeason: undefined };

for (const reason of RAG_DISCARD_REASONS) {
  const answer = renderRagHold({ kind: "insufficient", reason });
  assert.doesNotMatch(answer, /이해하지 못|구체적으로|다시 작성|공식 자료가 없/);
}
// The same validator result must not diagnose the user's intent or blame
// the available evidence. No expression classifier is added to production.
for (const question of ["음 그렇구나", "응 너 야알못", "나 혈압 120나옴", "왤케 억양이 안조아", "미안한데 프사바꾸는법도 아니..?"]) {
  const value = validateRagResponse(JSON.stringify({ status: "INSUFFICIENT" }),
    { numericEvidence: true, evidence: [official], generalFallback: { question } });
  assert.deepEqual(value, { kind: "insufficient", reason: "model_insufficient" });
  assert.equal(renderRagHold(value), RAG_NEUTRAL_HOLD);
  assert.doesNotMatch(renderRagHold(value), /질문|자료|근거|수치|날짜|이해|구체/);
}
for (const question of ["이해가 안돼… 예를 들어줘", "그니까 어떻게 읽냐고"]) {
  const value = validateRagResponse(JSON.stringify({ status: "GENERAL", answer: "7이라고 읽습니다." }),
    { numericEvidence: true, evidence: [official], generalFallback: { question } });
  assert.equal(value.kind, "insufficient");
  assert.equal(value.kind === "insufficient" && value.reason, "numeric_not_in_question");
  assert.equal(renderRagHold(value), RAG_NEUTRAL_HOLD);
}
assert.equal(renderRagHold({ kind: "insufficient", reason: "numeric_claim_ungrounded" }), RAG_NEUTRAL_HOLD);
assert.doesNotMatch(RAG_NUMBER_HOLD, /필요한|질문하신|자료가 없/);
async function run(path: "official" | "team", question: string, raw: string, expected: string, reason: string) {
  let stored: LlmResult | null = null;
  let calls = 0;
  let lastLog: Parameters<QaDeps["log"]>[0] | undefined;
  const provider = async () => { calls++; return { text: raw, inputTokens: 7, outputTokens: 3 }; };
  const deps: QaDeps = {
    enableTeamRag: true, now: () => Date.parse("2026-09-30T09:00:00Z"),
    loadGlossary: async () => [], loadPlayers: async () => [],
    getCache: async () => null, setCache: async () => { throw new Error("hold must not cache"); },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    searchOfficialRag: async () => path === "official" ? [official] : [], callOfficialRagLlm: provider,
    searchRag: async () => [team], callTeamRagLlm: provider,
    callLlm: async () => { throw new Error("no second generic provider"); },
    getLlmState: async () => ({ started: Boolean(stored), result: stored, ownerActive: false }),
    acquireLlmStart: async () => true, storeLlm: async (value) => { stored = value; },
    log: async (entry) => { lastLog = entry; },
  };
  const result = await answerQuestion("evidence-hold-fixture", question, deps);
  assert.equal(result.source, "unsure");
  assert.equal(result.answer, expected);
  assert.equal(calls, 1);
  assert.equal(lastLog?.ragDiscardReason, reason);
  assert.equal(lastLog?.ragAttemptPath, path);
  assert.equal(lastLog?.answer, expected);
  assert.ok(stored);
  const saved = unpackStoredQaFinal((stored as LlmResult).text)!;
  assert.equal(saved.answer, expected);
  assert.equal(saved.ragDiscardReason, reason);
  const replay = await answerQuestion("evidence-hold-fixture", question, deps);
  assert.equal(replay.answer, expected);
  assert.equal(replay.source, "unsure");
  assert.equal(calls, 1, "durable replay must not regenerate");
  assert.equal(lastLog?.ragDiscardReason, reason);
}
async function numericRecovery(mode: "success" | "still_invalid" | "general" | "error" | "stored" | "loser") {
  const evidence: RagEvidence = { ...official, calendarSeason: undefined,
    content: "인필드 플라이는 무사 또는 1사에 주자 1·2루 또는 만루일 때 적용합니다. 직선타구와 번트는 제외합니다." };
  const bad = "2아웃 만루에서는 인필드 플라이가 적용되지 않습니다.";
  const good = "해당 상황에서는 적용되지 않습니다. 무사 또는 1사에 주자 1·2루 또는 만루일 때 적용합니다.";
  const raw = (answer: string, status = "GROUNDED"): LlmResult => ({ text: JSON.stringify({ status, answer, calendarClaims: [] }), inputTokens: 7, outputTokens: 3 });
  let stored: LlmResult | null = mode === "stored" ? raw(bad) : null;
  let calls = 0;
  let lastLog: Parameters<QaDeps["log"]>[0] | undefined;
  const deps: QaDeps = {
    now: () => Date.parse("2026-10-02T09:00:00Z"),
    loadGlossary: async () => [], loadPlayers: async () => [],
    getCache: async () => null, setCache: async () => {},
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    searchOfficialRag: async () => [evidence],
    callOfficialRagLlm: async (question, selected, extras) => {
      calls++;
      assert.equal(question, "2아웃 만루에도 인필드플라이야?");
      assert.deepEqual(selected, [evidence]);
      if (calls === 1) { assert.equal(extras?.numericRepair, undefined); return raw(bad); }
      assert.equal(calls, 2, "repair budget exceeded");
      assert.equal(extras?.numericRepair?.answer, bad);
      assert.deepEqual(extras?.numericRepair?.quantityCandidates, ["2아웃"]);
      assert.equal(extras?.referenceTimeMs, deps.now!());
      if (mode === "error") throw new Error("repair provider failure");
      if (mode === "general") return raw("질문 상황에서는 적용됩니다.", "GENERAL");
      return raw(mode === "success" ? good : bad);
    },
    callLlm: async () => { throw new Error("must not fall through to generic provider"); },
    getLlmState: async () => ({ started: Boolean(stored), result: stored, ownerActive: false }),
    acquireLlmStart: async () => mode !== "loser",
    storeLlm: async value => { stored = value; },
    log: async entry => { lastLog = entry; },
  };
  const question = "2아웃 만루에도 인필드플라이야?";
  const result = await answerQuestion("numeric-recovery-fixture", question, deps);
  if (mode === "loser") { assert.equal(result.status, 202); assert.equal(calls, 0); return; }
  if (mode === "error") { assert.equal(result.source, "error"); assert.equal(calls, 2); return; }
  assert.equal(calls, mode === "stored" ? 0 : 2);
  if (mode === "success") {
    assert.ok(result.answer.includes(good));
    assert.notEqual(result.source, "unsure");
    assert.equal(lastLog?.inputTokens, 14);
    assert.equal(lastLog?.outputTokens, 6);
  } else {
    assert.equal(result.source, "unsure");
    assert.equal(lastLog?.ragDiscardReason, mode === "general" ? "model_insufficient" : "numeric_not_in_evidence");
  }
  const before = calls;
  const replay = await answerQuestion("numeric-recovery-fixture", question, deps);
  assert.equal(replay.answer, result.answer);
  assert.equal(calls, before, "stored final must not generate again");
}

async function main() {
  for (const mode of ["success", "still_invalid", "general", "error", "stored", "loser"] as const) await numericRecovery(mode);
  await run("official", "2026년 가을야구는 언제 시작해?", JSON.stringify({ status: "GROUNDED", answer: "10월 6일 시작합니다.", calendarClaims: [{ basis: "question", season: 2026, evidence: 1 }] }), RAG_DATE_HOLD, "event_date_unverified");
  await run("official", "인필드 플라이 규칙 알려줘", JSON.stringify({ status: "INSUFFICIENT" }), RAG_NEUTRAL_HOLD, "model_insufficient");
  await run("official", "인필드 플라이 규칙 알려줘", "not-json", RAG_RESPONSE_HOLD, "malformed_json");
  await run("official", "인필드 플라이 규칙 알려줘", JSON.stringify({ status: "GROUNDED", answer: "7명이 아웃됩니다.", calendarClaims: [] }), RAG_NUMBER_HOLD, "numeric_not_in_evidence");
  await run("team", "두산 홈구장은 사직이야?", JSON.stringify({ status: "INSUFFICIENT" }), RAG_NEUTRAL_HOLD, "model_insufficient");
  await run("team", "두산 홈구장은 어디야?", JSON.stringify({ status: "GROUNDED", answer: "7개의 구장을 사용합니다." }), RAG_NEUTRAL_HOLD, "numeric_claim_ungrounded");
  await run("official", "인필드 플라이 규칙 알려줘", JSON.stringify({ status: "GENERAL", answer: "7명이 아웃됩니다." }), RAG_NEUTRAL_HOLD, "numeric_not_in_question");
  console.log("evidence hold pipeline/storage/replay checks passed; factual answer recovery NOT evaluated");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
