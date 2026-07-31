import assert from "node:assert/strict";

import { RAG_EMBEDDING_DIM } from "../../src/lib/baseball-qa/rag/contracts";
import { embedDocument, RAG_EMBEDDING_MODEL } from "../../src/lib/baseball-qa/rag/embed";

async function main() {
  const result = await embedDocument(
    "KBO 공식 기록과 선수 문서 검색을 위한 짧은 회귀검증 문장입니다.",
    "KBO 리그",
  );
  assert.equal(result.ok, true, result.ok ? undefined : `live embedding failed: ${result.reason}`);
  if (!result.ok) process.exit(1);
  assert.equal(result.vector.length, RAG_EMBEDDING_DIM);
  assert.ok(result.vector.every(Number.isFinite));

  console.log(`baseball QA live embedding PASS (${RAG_EMBEDDING_MODEL}, ${RAG_EMBEDDING_DIM} finite values)`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
