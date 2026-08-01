import assert from "node:assert/strict";

import {
  canGroundNumericClaim,
  gradeForSourceKind,
  RAG_EMBEDDING_DIM,
  resolveNumericConflict,
} from "../../src/lib/baseball-qa/rag/contracts";
import {
  embedDocument,
  embedQuery,
  formatDocumentInput,
  formatQueryInput,
  RAG_EMBEDDING_MODEL,
} from "../../src/lib/baseball-qa/rag/embed";
import {
  MAX_CHUNK_CHARS,
  MIN_CHUNK_CHARS,
  prepareTier2Chunks,
} from "../../src/lib/baseball-qa/rag/ingest";

assert.equal(gradeForSourceKind("kbo_structured"), "tier1");
assert.equal(gradeForSourceKind("namu_document"), "tier2");
assert.equal(canGroundNumericClaim("tier1"), true);
assert.equal(canGroundNumericClaim("tier2"), false);
assert.equal(resolveNumericConflict("0.321", "0.300").decision, "use_official");
assert.equal(resolveNumericConflict(null, "0.300").decision, "hold_numeric");

const prepared = prepareTier2Chunks({
  entityType: "player",
  entityId: "75847",
  pageTitle: "테스트 선수",
  canonicalUrl: "https://namu.wiki/w/test",
  revision: "r1",
  sectionPath: "개요",
  crawledAt: "2026-07-31T00:00:00Z",
  asOf: "2026-07-31",
  rawText: `== 개요 ==\n\n${"선수의 서술형 경력 정보입니다. ".repeat(80)}`,
});
assert.equal(prepared.ok, true);
if (prepared.ok) {
  assert.ok(prepared.chunks.length > 0);
  assert.ok(prepared.chunks.every(({ content, contentChars, documentContentHash, meta }) =>
    content.length === contentChars &&
    contentChars >= MIN_CHUNK_CHARS &&
    contentChars <= MAX_CHUNK_CHARS &&
    meta.sourceGrade === "tier2" &&
    Boolean(meta.contentHash) && Boolean(documentContentHash)));
  assert.equal(new Set(prepared.chunks.map(({ documentContentHash }) => documentContentHash)).size, 1);
}
assert.equal(prepareTier2Chunks({
  entityType: "player",
  entityId: "75847",
  pageTitle: "테스트 선수",
  canonicalUrl: "",
  revision: "r1",
  sectionPath: "개요",
  crawledAt: "2026-07-31T00:00:00Z",
  asOf: "2026-07-31",
  rawText: "메타 결측 시 저장하면 안 되는 충분히 긴 테스트 문장입니다.",
}).ok, false);

async function verifyEmbeddingContract() {
process.env.GEMINI_API_KEY = "test-key";
const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
const mockFetch: typeof fetch = async (input, init) => {
  calls.push({
    url: String(input),
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  });
  return new Response(JSON.stringify({
    embedding: { values: Array.from({ length: RAG_EMBEDDING_DIM }, (_, index) => index / 1000) },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

assert.equal((await embedDocument("문서", "이정후", mockFetch)).ok, true);
assert.equal((await embedQuery("질문", mockFetch)).ok, true);
assert.equal((await embedDocument("제목 없는 문서", null, mockFetch)).ok, true);
for (const call of calls) {
  assert.ok(call.url.includes(`/models/${RAG_EMBEDDING_MODEL}:embedContent`));
  assert.equal(call.body.model, `models/${RAG_EMBEDDING_MODEL}`);
  assert.equal(call.body.outputDimensionality, RAG_EMBEDDING_DIM);
  assert.equal("taskType" in call.body, false);
}

// Gemini Embedding 2 공식 asymmetric retrieval 포맷을 exact로 고정한다.
const sentText = (index: number): string =>
  ((calls[index].body.content as { parts: { text: string }[] }).parts[0].text);
assert.equal(sentText(0), "title: 이정후 | text: 문서");
assert.equal(sentText(1), "task: search result | query: 질문");
assert.equal(sentText(2), "title: none | text: 제목 없는 문서");
assert.equal(formatQueryInput("질문"), "task: search result | query: 질문");
assert.equal(formatDocumentInput("본문", "  "), "title: none | text: 본문");
assert.equal(formatDocumentInput("본문", " KBO 리그 "), "title: KBO 리그 | text: 본문");

const nonFiniteFetch: typeof fetch = async () => new Response(JSON.stringify({
  embedding: { values: [...Array(RAG_EMBEDDING_DIM - 1).fill(0), null] },
}), { status: 200, headers: { "Content-Type": "application/json" } });
assert.deepEqual(
  await embedDocument("문서", "제목", nonFiniteFetch),
  { ok: false, reason: "non_finite_value" },
);

console.log("baseball QA RAG contracts PASS (tier/canonical/meta/chunk/gemini-embedding-2 asymmetric prefix)");
}

verifyEmbeddingContract().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
