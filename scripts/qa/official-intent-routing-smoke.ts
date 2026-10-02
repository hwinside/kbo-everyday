/** Independent reviewer execution only. */
import assert from "node:assert/strict";
import {buildOfficialContextRequest} from "../../src/lib/baseball-qa/rag/official-context-request";
import {intentRoutingRequest, INTENT_ROUTING_NOTE} from "../baseball-qa/rag/experimental-intent-routing";
import {contextRoutingRequest} from "../baseball-qa/rag/experimental-context-routing";
import type {RagEvidence} from "../../src/lib/baseball-qa/rag/retrieve";
const evidence: RagEvidence[] = [{content:"공식 근거",sectionPath:"규칙#p1",pageTitle:"규칙",canonicalUrl:"https://example.test/rule",revision:"r1",asOf:"2026-10-03",sourceKind:"kbo_ebook",sourceGrade:"tier1"}];
const common = {referenceTimeMs: Date.UTC(2026,9,3)};
for (const question of ["그건 플라이아웃 아니야?","이사에서는 인필드 플라이가 없어?","2024년 최다안타"]){
  assert.deepEqual(intentRoutingRequest(question,evidence,common),buildOfficialContextRequest(question,evidence,common));
  const extras = {...common,context:{question:"포구는 뭐야?",answer:"오류일 수 있는 답변"}};
  const base = buildOfficialContextRequest(question,evidence,extras);
  assert.deepEqual(contextRoutingRequest(question,evidence,extras),base,"control is production payload");
  const candidate = intentRoutingRequest(question,evidence,extras);
  assert.deepEqual(candidate.contents,base.contents);
  assert.deepEqual(candidate.generationConfig,base.generationConfig);
  assert.equal(candidate.systemInstruction.parts[0].text,base.systemInstruction.parts[0].text+"\n"+INTENT_ROUTING_NOTE);
}
console.log("PASS: control production identity; context-only instruction; evidence/config preservation");
