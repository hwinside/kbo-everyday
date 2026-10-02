/** Reviewer executes: npx tsx scripts/qa/official-sibling-evidence-smoke.ts */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {siblingEvidence,validateSiblingManifest,type SiblingManifest} from "../baseball-qa/rag/experimental-sibling-evidence";
import {buildOfficialContextRequest} from "../../src/lib/baseball-qa/rag/official-context-request";
import type {RagEvidence} from "../../src/lib/baseball-qa/rag/retrieve";
const hash = (s:string) => createHash("sha256").update(s).digest("hex");
const lead = "다음의 경우 타자는 아웃된다.";
const item = "⑸ 정규의 조건이 모두 성립하였을 경우";
const text = `${lead}\n${item}`;
const row = (content:string,sectionPath:string):RagEvidence => ({content,sectionPath,
  pageTitle:"공식 문서",canonicalUrl:"https://example.test/book.pdf",revision:"r1",asOf:"2026-10-02",sourceKind:"kbo_ebook",sourceGrade:"tier1"});
const anchor = row("1.01 판정 (이어짐)\n[부기] 별도 예외 조건이 있다.","공식 문서#p3");
const sibling = row(`1.01 판정 (이어짐)\n${item}`,"공식 문서#p2");
const manifest:SiblingManifest[] = [{canonicalUrl:sibling.canonicalUrl,sourceRevision:sibling.revision,
  section:sibling.sectionPath,rawContentSha256:hash(sibling.content),bindings:[{
    section:"1.01 판정 / ⒜ / ⑸",lead,item,sourceText:text,sourceTextSha256:hash(text),leadStart:0,itemStart:lead.length+1}]}];
validateSiblingManifest(manifest);
const primary = [anchor,...Array.from({length:5},(_,i) => row(`2.01 다른 조항 ${i}`,`공식 문서#p${10+i}`))];
const saved = JSON.stringify(primary);
const result = siblingEvidence(primary,[anchor,sibling],manifest);
assert.equal(result.trace.length,1);
assert.equal(result.primaryCount,6);
assert.equal(result.physicalChunkCount,7);
assert.equal(JSON.stringify(primary),saved,"do not mutate guard evidence");
assert.equal(result.modelEvidence.length,7);
assert.deepEqual(result.modelEvidence.slice(0,6),primary);
assert.ok(result.modelEvidence[6].content.includes(sibling.sectionPath));
assert.deepEqual({...result.modelEvidence[6],content:sibling.content},sibling);
for (const bad of [{...sibling,revision:"stale"},{...sibling,canonicalUrl:"https://other.test"},
  {...sibling,content:sibling.content+" changed"},{...sibling,sourceGrade:"tier3" as const}]) {
  assert.equal(siblingEvidence(primary,[bad],manifest).trace.length,0);
}
assert.equal(siblingEvidence([{...anchor,content:"2.01 다른 조항"}],[sibling],manifest).trace.length,0);
assert.equal(siblingEvidence([anchor,sibling],[sibling],manifest).trace.length,0);
assert.equal(siblingEvidence(primary,[],manifest).trace.length,0);
assert.throws(()=>validateSiblingManifest([...manifest,...manifest]));
assert.throws(()=>validateSiblingManifest([{...manifest[0],bindings:[{...manifest[0].bindings[0],leadStart:1}]}]));
const extras = {referenceTimeMs:Date.parse("2026-10-02T12:00:00Z")};
const base = buildOfficialContextRequest("판정은?",primary,extras);
const cand = buildOfficialContextRequest("판정은?",result.modelEvidence,extras);
assert.deepEqual(cand.systemInstruction,base.systemInstruction);
assert.deepEqual(cand.generationConfig,base.generationConfig);
assert.ok(cand.contents[0].parts[0].text.includes("2026-10-02"));
const baseText = base.contents[0].parts[0].text;
const candText = cand.contents[0].parts[0].text;
assert.ok(candText.includes("[자료7]"));
assert.equal(candText.split("[자료7]")[0].trimEnd(),baseText.split("<자료 끝>")[0].trimEnd(),
  "first six complete rendered records, date and annotations must stay identical");
assert.ok(candText.split("[자료7]")[1].includes('"sectionPath":"공식 문서#p2"'));
console.log("PASS: source binding, spans, missing candidates, preservation, explicit physical count and request contract");
