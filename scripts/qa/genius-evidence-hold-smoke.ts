/** Reviewer-run: real pipeline validation, final storage and retry replay. No network. */
import assert from "node:assert/strict";
import { answerQuestion, unpackStoredQaFinal, type QaDeps, type LlmResult } from "../../src/lib/baseball-qa/pipeline";
import { RAG_DISCARD_REASONS, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";
import { renderRagHold, RAG_DATE_HOLD, RAG_NUMBER_HOLD, RAG_EVIDENCE_HOLD, RAG_RESPONSE_HOLD } from "../../src/lib/baseball-qa/rag/hold-answer";

const official: RagEvidence = { content: "2025년 포스트시즌은 10월 6일 시작했다.", pageTitle: "연감", sectionPath: "포스트시즌",
  canonicalUrl: "https://www.koreabaseball.com/kbo/board/ebook/ebookpublication.aspx", revision: "fixture", asOf: "2026-09-30", sourceGrade: "tier1",
  calendarSeason: { season: 2025, axis: "calendar_event", heading: "2025 포스트시즌", headingPage: 1, pageTextSha256: "a".repeat(64), sourcePdfSha256: "b".repeat(64) } };
const team: RagEvidence = { ...official, content: "두산 베어스는 서울종합운동장 야구장을 홈구장으로 사용한다.", pageTitle: "두산 베어스", sectionPath: "홈구장",
  canonicalUrl: "https://namu.wiki/w/두산%20베어스", sourceGrade: "tier2", calendarSeason: undefined };

for (const reason of RAG_DISCARD_REASONS) {
  const answer = renderRagHold({ kind: "insufficient", reason });
  assert.doesNotMatch(answer, /이해하지 못|구체적으로|다시 작성|공식 자료가 없/);
}
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
async function main() {
  await run("official", "2026년 가을야구는 언제 시작해?", JSON.stringify({ status: "GROUNDED", answer: "10월 6일 시작합니다.", calendarClaims: [{ basis: "question", season: 2026, evidence: 1 }] }), RAG_DATE_HOLD, "event_date_unverified");
  await run("official", "인필드 플라이 규칙 알려줘", JSON.stringify({ status: "INSUFFICIENT" }), RAG_EVIDENCE_HOLD, "model_insufficient");
  await run("official", "인필드 플라이 규칙 알려줘", "not-json", RAG_RESPONSE_HOLD, "malformed_json");
  await run("official", "인필드 플라이 규칙 알려줘", JSON.stringify({ status: "GROUNDED", answer: "7명이 아웃됩니다.", calendarClaims: [] }), RAG_NUMBER_HOLD, "numeric_not_in_evidence");
  await run("team", "두산 홈구장은 사직이야?", JSON.stringify({ status: "INSUFFICIENT" }), RAG_EVIDENCE_HOLD, "model_insufficient");
  console.log("evidence hold pipeline/storage/replay checks passed; factual answer recovery NOT evaluated");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
