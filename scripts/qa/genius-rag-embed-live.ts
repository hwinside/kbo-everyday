/**
 * 임베딩 실호출 회귀 (삼순 재리뷰 #2: "actual model response 768 finite-number 회귀").
 * 실행: npx tsx scripts/qa/genius-rag-embed-live.ts
 *
 * 실제 Gemini API를 호출하므로 prebuild(오프라인 게이트)에는 넣지 않는다.
 * GEMINI_API_KEY가 없으면 SKIP(부재를 실패로 만들지 않되, 조용히 통과시키지도 않는다).
 */

import { RAG_EMBEDDING_DIM, RAG_EMBEDDING_MODEL } from "../../src/lib/baseball-qa/rag/contracts";
import { embedChunk, embedQuery } from "../../src/lib/baseball-qa/rag/embed";

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.log("SKIP: GEMINI_API_KEY 미설정 — 실호출 회귀를 건너뜀(통과로 세지 않음)");
    return;
  }

  console.log(`model=${RAG_EMBEDDING_MODEL} expectedDim=${RAG_EMBEDDING_DIM}`);
  let failed = 0;

  const doc = await embedChunk(
    "김도영은 KIA 타이거즈 소속의 내야수이다. 우투우타 3루수로 뛴다.",
    "김도영",
  );
  if (!doc.ok) {
    console.error(`✗ 문서 임베딩 실패: ${doc.reason}`);
    failed++;
  } else {
    const finite = doc.vector.every((v) => Number.isFinite(v));
    console.log(
      `${doc.vector.length === RAG_EMBEDDING_DIM && finite ? "✓" : "✗"} 문서 임베딩 len=${doc.vector.length} finite=${finite}`,
    );
    if (doc.vector.length !== RAG_EMBEDDING_DIM || !finite) failed++;
  }

  const query = await embedQuery("김도영 누구야");
  if (!query.ok) {
    console.error(`✗ 질의 임베딩 실패: ${query.reason}`);
    failed++;
  } else {
    const finite = query.vector.every((v) => Number.isFinite(v));
    console.log(
      `${query.vector.length === RAG_EMBEDDING_DIM && finite ? "✓" : "✗"} 질의 임베딩 len=${query.vector.length} finite=${finite}`,
    );
    if (query.vector.length !== RAG_EMBEDDING_DIM || !finite) failed++;
  }

  console.log(failed === 0 ? "PASS" : "FAIL");
  process.exit(failed === 0 ? 0 : 1);
}

void main();
