import anchorHeaderFixture from "./fixtures/genius-anchor-header-20261003.json";
import anchorFixture from "./fixtures/genius-sibling-anchor-20261003.json";
import candidatesFixture from "./fixtures/official-sibling-serving-candidates.json";
import { answerQuestion, type QaDeps } from "../../src/lib/baseball-qa/pipeline";
/** Reviewer executes: npx tsx scripts/qa/official-sibling-serving-smoke.ts */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {standaloneSiblingEvidence,siblingEvidence,validateSiblingManifest,prepareOfficialEvidence,anchorCarriesStructuralUnit,type SiblingManifest} from "../../src/lib/baseball-qa/rag/official-sibling-evidence";
import {buildOfficialContextRequest} from "../../src/lib/baseball-qa/rag/official-context-request";
import {validateRagResponse, type RagEvidence} from "../../src/lib/baseball-qa/rag/retrieve";
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
assert.equal(result.modelEvidence.length,6);
assert.ok(result.modelEvidence[0].content.startsWith(anchor.content));
assert.deepEqual(result.modelEvidence.slice(1),primary.slice(1));
assert.ok(result.modelEvidence[0].content.includes(sibling.sectionPath));
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
console.log("PASS: source binding, spans, missing candidates, preservation, explicit physical count and request contract");

// #1526 P1: a dangling continuation anchor has no enumeration position, so no sibling
// may be bound there. Captured serving chunks, not synthetic strings.
assert.equal(anchorFixture.anchors.length, 2);
for (const captured of anchorFixture.anchors) {
  assert.equal(anchorCarriesStructuralUnit(captured.content), captured.eligible, captured.sectionPath);
  const capturedAnchor = row(captured.content, captured.sectionPath);
  const capturedSibling = row(`5.09 아웃 (이어짐)\n${item}`, "2026 공식야구규칙#p60");
  const capturedManifest: SiblingManifest[] = [{ canonicalUrl: capturedSibling.canonicalUrl,
    sourceRevision: capturedSibling.revision, section: capturedSibling.sectionPath,
    rawContentSha256: hash(capturedSibling.content), bindings: [{ section: "5.09 아웃 / ⒜ / ⑸",
      lead, item, sourceText: text, sourceTextSha256: hash(text), leadStart: 0, itemStart: lead.length + 1 }] }];
  validateSiblingManifest(capturedManifest);
  const capturedPrimary = [capturedAnchor, ...Array.from({ length: 5 }, (_, i) => row(`2.01 다른 조항 ${i}`, `공식 문서#p${20 + i}`))];
  const bundle = siblingEvidence(capturedPrimary, [capturedSibling], capturedManifest);
  assert.equal(bundle.trace.length, captured.eligible ? 1 : 0, captured.sectionPath);
  assert.equal(bundle.physicalChunkCount, captured.eligible ? 7 : 6);
  if (!captured.eligible) assert.deepEqual(bundle.modelEvidence, capturedPrimary, "ineligible anchor must stay byte-identical");
}
console.log("PASS: captured continuation anchors classified by structural unit; ineligible anchor keeps baseline evidence");

// #1529 nit: served pages do not always break the article header onto its own line,
// so cutting the header at the first newline erased the whole body. These are real
// serving rows that every one of them carries an item number or a bracketed label.
assert.equal(anchorHeaderFixture.anchors.length, 7);
assert.equal(anchorHeaderFixture.anchors.filter(a => a.newlineCount === 0).length, 4);
for (const captured of anchorHeaderFixture.anchors) {
  assert.equal((captured.content.match(/\n/g) ?? []).length, captured.newlineCount, captured.sectionPath);
  assert.equal(anchorCarriesStructuralUnit(captured.content), captured.eligible, captured.sectionPath);
  // The pre-#1530 cut dropped everything before the first newline, so a page with no
  // newline lost its whole body. Assert that only where it is actually meaningful.
  if (captured.newlineCount === 0) {
    assert.equal(captured.content.split("\n").slice(1).join("\n"), "", captured.sectionPath);
    assert.equal(anchorCarriesStructuralUnit(captured.content.split("\n").slice(1).join("\n")), false, captured.sectionPath);
  }
}
// A cross-reference such as "7. 02(c) 참조" sits inside a line and must not qualify.
assert.equal(anchorCarriesStructuralUnit("5.10 선수교체 앞 문장이 이어지며 7. 02(c) 참조 라고만 적혀 있다."), false);
assert.equal(anchorCarriesStructuralUnit("5.12 타임 선언\n(D) 등판 중인 투수가 지명타자의 대타자가 되었을 때"), true);
console.log("PASS: article-number header cut keeps single-line serving pages classifiable");

// R3 must equal B without context and A with any present context object.
const standalone = standaloneSiblingEvidence(primary,[anchor,sibling],manifest,extras);
assert.deepEqual(standalone,{...result,skippedForContext:false,skipReason:null});
assert.deepEqual(standaloneSiblingEvidence(primary,[anchor,sibling],manifest),standalone);
for (const context of [{question:"포구는 뭐야?",answer:"잡는 행위"},
  {question:"규칙 조건은?",answer:"규칙 답변"},{question:"",answer:""}]) {
  const contextual = {...extras,context};
  const skipped = standaloneSiblingEvidence(primary,[anchor,sibling],manifest,contextual);
  assert.equal(skipped.modelEvidence,primary);
  assert.equal(skipped.trace.length,0);
  assert.equal(skipped.physicalChunkCount,6);
  assert.equal(skipped.skippedForContext,true);
  assert.deepEqual(buildOfficialContextRequest("후속 질문",skipped.modelEvidence,contextual),
    buildOfficialContextRequest("후속 질문",primary,contextual));
}
// Recordbook requests keep the record-selection contract: no seventh rule chunk.
for (const recordbookExtras of [{...extras,recordbookRequest:true},
  {...extras,recordbookRequest:true,allowRecordbookGeneral:true}]) {
  const skipped = standaloneSiblingEvidence(primary,[anchor,sibling],manifest,recordbookExtras);
  assert.equal(skipped.modelEvidence,primary);
  assert.equal(skipped.guardEvidence,primary);
  assert.equal(skipped.trace.length,0);
  assert.equal(skipped.physicalChunkCount,6);
  assert.equal(skipped.skippedForContext,false);
  assert.equal(skipped.skipReason,"recordbook");
}
// A context turn stays a context skip even when the recordbook flag is also set.
assert.equal(standaloneSiblingEvidence(primary,[anchor,sibling],manifest,
  {...extras,recordbookRequest:true,context:{question:"기록은?",answer:"기록 답변"}}).skipReason,"context");
assert.equal(standaloneSiblingEvidence(primary,[anchor,sibling],manifest,
  {...extras,recordbookRequest:false}).trace.length,1);
assert.equal(JSON.stringify(primary),saved);
console.log("PASS: standalone equals B; context and recordbook requests equal A payload, no mutation");

// Model-visible numeric spans ground; unseen source text/metadata never ground.
assert.deepEqual(result.rawEvidence, [...primary, sibling]);
assert.equal(result.guardEvidence.length, 7);
assert.deepEqual(result.guardEvidence.slice(0, 6), primary);
assert.ok(result.guardEvidence[6].content.includes(lead));
assert.ok(!result.guardEvidence[6].content.includes("rawContentSha256"));
assert.throws(() => siblingEvidence([...primary, sibling], [], manifest));
const numericLead = "77회가 되면 타자는 아웃된다.";
const numericItem = "⑸ 정규의 조건이 모두 성립하였을 경우";
const numericSource = `${numericLead}\n${numericItem}\n노출하지 않는 다른 항목 88회`;
const numericSibling = {...sibling, content: `1.01 판정\n${numericItem}`};
const numericManifest = [{...manifest[0], rawContentSha256: hash(numericSibling.content), bindings: [{
  ...manifest[0].bindings[0], lead: numericLead, item: numericItem,
  sourceText: numericSource, sourceTextSha256: hash(numericSource), leadStart: 0,
  itemStart: numericLead.length + 1,
}]}];
validateSiblingManifest(numericManifest);
const numeric = siblingEvidence(primary, [numericSibling], numericManifest);
const raw77 = JSON.stringify({status: "GROUNDED", answer: "77회가 되면 아웃이에요."});
const raw88 = JSON.stringify({status: "GROUNDED", answer: "88회가 되면 아웃이에요."});
const validate = (text: string, evidence: RagEvidence[]) => validateRagResponse(text, {numericEvidence: true, evidence});
assert.equal(validate(raw77, primary).kind, "insufficient");
assert.equal(validate(raw77, numeric.guardEvidence).kind, "grounded");
assert.equal(validate(raw88, numeric.guardEvidence).kind, "insufficient");
console.log("PASS: independent seven-source grounding; shown spans allowed, unseen source spans blocked");

async function pipelineContract() {
  let calls = 0;
  const bundles: ReturnType<typeof prepareOfficialEvidence>[] = [];
  const raw = {text: JSON.stringify({status: "GROUNDED", answer: "인필드 플라이가 선언되면 타자는 아웃이에요.", correctsPrevious: false, contextMeaning: "", calendarClaims: []}), inputTokens: 1, outputTokens: 1};
  const deps: QaDeps = {
    loadGlossary: async () => [], loadPlayers: async () => [],
    getCache: async () => null, setCache: async () => {},
    reserveDaily: async () => ({allowed: true, remaining: 9}), log: async () => {},
    now: () => Date.parse("2026-10-02T12:00:00Z"),
    searchOfficialRag: async () => candidatesFixture as RagEvidence[],
    observeOfficialEvidence: b => { bundles.push(b); },
    callOfficialRagLlm: async (_q, model) => {
      calls++;
      assert.deepEqual(model, bundles.at(-1)!.modelEvidence);
      return raw;
    },
    callLlm: async () => { throw new Error("unexpected generic call"); },
  };
  const final = await answerQuestion("qa-sibling-only", "그건 플라이아웃 아니야?", deps);
  assert.equal(calls, 1);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].physicalChunkCount, 7);
  assert.equal(bundles[0].guardEvidence.length, 7);
  assert.equal(bundles[0].trace[0].section, "2026 공식야구규칙#p60");
  assert.equal(final.source, "rag");
  assert.equal(final.sourceUrl, "https://www.koreabaseball.com/kbo/board/ebook/ebookpublication.aspx");
  console.log("PASS: real pipeline -> model bundle -> guard/final/provenance, one provider call");
}
void pipelineContract();
