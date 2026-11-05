import assert from "node:assert/strict";
import fs from "node:fs";
import { contextRoutingRequest, CONTEXT_ROUTING_NOTE } from "../baseball-qa/rag/experimental-context-routing";
import { buildRagLlmRequest, RAG_OFFICIAL_SYSTEM_PROMPT, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/official-parenthetical-serving.json", import.meta.url), "utf8"));
const sample = fixture.rows.find((x: {row: {section: string}}) => x.row.section.includes("40. INFIELD FLY"));
assert.ok(sample);
const evidence: RagEvidence[] = [{content:sample.row.text, sourceKind:"kbo_ebook", sourceGrade:"tier1",
  canonicalUrl:sample.row.canonicalUrl, revision:sample.row.revision,
  pageTitle:"2026 공식야구규칙", sectionPath:sample.row.section, asOf:"2026-10-02"}];
for (const q of ["이사에서는 인필드 플라이가 없어?", "2사 1·2루 인필드플라이야?", "2024년 최다안타", "그건 플라이아웃 아니야?"]) {
  assert.deepEqual(contextRoutingRequest(q,evidence), buildRagLlmRequest(q,evidence,RAG_OFFICIAL_SYSTEM_PROMPT));
}
const extras = {referenceTimeMs: Date.UTC(2026,9,2), context:{question:"포구는 뭐야?",answer:"잘못된 이전 답변"}};
const before = JSON.stringify(evidence);
const base = buildRagLlmRequest("그건 플라이아웃 아니야?",evidence,RAG_OFFICIAL_SYSTEM_PROMPT,extras);
const cand = contextRoutingRequest("그건 플라이아웃 아니야?",evidence,extras);
assert.deepEqual(cand.contents,base.contents);
for (const marker of ["<요청 기준일 — 서버 시계>", "문서 메타데이터:", "제외 항목 A: 직선타구", "제외 항목 B: 번트한 것이"]) {
  assert.ok(cand.contents[0].parts[0].text.includes(marker), marker);
}
assert.deepEqual({...cand, systemInstruction:base.systemInstruction}, base);
assert.deepEqual(cand.generationConfig,base.generationConfig);
assert.equal(cand.systemInstruction.parts[0].text,`${base.systemInstruction.parts[0].text}\n${CONTEXT_ROUTING_NOTE}`);
assert.equal(JSON.stringify(evidence),before);
console.log("PASS: absent context identical; evidence/payload/schema preserved; context-only instruction");
