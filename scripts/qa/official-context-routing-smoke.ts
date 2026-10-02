import assert from "node:assert/strict";
import { contextRoutingRequest, CONTEXT_ROUTING_NOTE } from "../baseball-qa/rag/experimental-context-routing";
import { buildRagLlmRequest, RAG_OFFICIAL_SYSTEM_PROMPT, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";
const evidence = [{content:"원문 근거", sourceKind:"kbo_ebook", sourceGrade:"tier1", canonicalUrl:"https://example.com/rules", pageTitle:"공식", sectionPath:"test"}] as RagEvidence[];
for (const q of ["이사에서는 인필드 플라이가 없어?", "2사 1·2루 인필드플라이야?", "2024년 최다안타", "그건 플라이아웃 아니야?"]) {
  assert.deepEqual(contextRoutingRequest(q,evidence), buildRagLlmRequest(q,evidence,RAG_OFFICIAL_SYSTEM_PROMPT));
}
const extras = {context:{question:"포구는 뭐야?",answer:"잘못된 이전 답변"}};
const before = JSON.stringify(evidence);
const base = buildRagLlmRequest("그건 플라이아웃 아니야?",evidence,RAG_OFFICIAL_SYSTEM_PROMPT,extras);
const cand = contextRoutingRequest("그건 플라이아웃 아니야?",evidence,extras);
assert.deepEqual(cand.contents,base.contents);
assert.deepEqual(cand.generationConfig,base.generationConfig);
assert.equal(cand.systemInstruction.parts[0].text,`${base.systemInstruction.parts[0].text}\n${CONTEXT_ROUTING_NOTE}`);
assert.equal(JSON.stringify(evidence),before);
console.log("PASS: absent context identical; evidence/payload/schema preserved; context-only instruction");
