/** Reviewer-owned binding/mutation checks; not a semantic correctness verdict. */
import assert from "node:assert/strict";
import fs from "node:fs";
import notes from "../../src/lib/baseball-qa/rag/official-rule-interpretations.json";
import { officialRuleInterpretation, officialRuleScopePreamble, officialInterpretationSummary, OFFICIAL_INTERPRETATION_APPLICATION_PROMPT } from "../../src/lib/baseball-qa/rag/official-rule-interpretation";
import { officialModelEvidenceContent } from "../../src/lib/baseball-qa/rag/official-parenthetical-evidence";
import { annotationContentDigest } from "../../src/lib/baseball-qa/rag/official-parenthetical-structure.mjs";
import { buildRagLlmRequest, RAG_OFFICIAL_SYSTEM_PROMPT, RAG_SYSTEM_PROMPT, sanitizeEvidenceContent, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";

const corpus = fs.readFileSync("data/baseball-qa/kbo-substitution-2026.jsonl", "utf8")
  .trim().split("\n").map(line => JSON.parse(line));
const audit = JSON.parse(fs.readFileSync("data/baseball-qa/kbo-substitution-2026.audit.json", "utf8"));
const fullText = corpus.map(row => row.text).join("\n");
assert.equal(notes.length, 5);
for (const note of notes) {
  assert.equal(note.sourceRevision, audit.revision);
  const source = corpus.find(row => annotationContentDigest(row.text) === note.contentSha256);
  assert.ok(source, "binding must point to a complete real chunk");
  assert.equal(note.canonicalUrl, `https://6ptotvmi5753.edge.naverncp.com/KBO_FILE/ebook/pdf/${encodeURIComponent(source.file)}`);
  for (const quote of note.sourceQuotes) assert.ok(fullText.includes(quote), "related quotation must be verbatim");
  for (const rule of note.scopedRules ?? []) {
    for (const quote of rule.quotes) assert.ok(fullText.includes(quote), "scope-linked quote must remain verbatim");
  }
  const row: RagEvidence = {content: source.text, revision: audit.revision, canonicalUrl: `https://6ptotvmi5753.edge.naverncp.com/KBO_FILE/ebook/pdf/${source.file}`,
    pageTitle: source.title, sectionPath: `${source.title}#${source.section}`, asOf: source.fetchedAt.slice(0, 10),
    sourceGrade: "tier1", sourceKind: "kbo_ebook"};
  // Production loader/DB URL is Unicode, not a URL synthesized from the notes.
  assert.equal(row.canonicalUrl, decodeURI(note.canonicalUrl));
  assert.ok(officialRuleInterpretation(row), "production Unicode URL must bind");
  for (const canonicalUrl of [note.canonicalUrl, note.canonicalUrl.replace(/%[0-9A-F]{2}/g, x => x.toLowerCase())]) {
    const encoded = {...row, canonicalUrl};
    assert.equal(officialRuleInterpretation(encoded), officialRuleInterpretation(row));
    assert.equal(officialRuleScopePreamble(encoded), officialRuleScopePreamble(row));
    assert.equal(officialInterpretationSummary([encoded]), officialInterpretationSummary([row]));
  }
  const original = structuredClone(row);
  const rendered = officialModelEvidenceContent(row);
  const preamble = officialRuleScopePreamble(row);
  assert.ok(rendered.startsWith(preamble + row.content), "original evidence must remain intact after editorial scope preamble");
  if (note.scopedRules) {
    assert.ok(preamble.includes("KBO 퓨처스리그에만 적용 — KBO 1군에는 적용하지 않음"));
    assert.ok(preamble.includes("5.10(i)"));
    assert.ok(preamble.includes("일반 규칙 (KBO 1군 포함)"));
    const renderedRules = officialRuleInterpretation(row).split("\n").filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert.deepEqual(renderedRules, note.scopedRules, "quotes must travel with their own scope, not orphaned");
  } else assert.equal(preamble, "", "position-change notes are untouched");
  assert.ok(rendered.includes(note.interpretation));
  assert.deepEqual(row, original, "rendering must not alter grounding/provenance input");
  assert.ok(officialRuleInterpretation({...row, content: sanitizeEvidenceContent(row.content, row)}), "actual serving sanitizer must preserve binding");
  const mutations: Partial<RagEvidence>[] = [
    {canonicalUrl: row.canonicalUrl + "%"},
    {canonicalUrl: row.canonicalUrl + "%E0%A4"},
    {canonicalUrl: row.canonicalUrl.replace("/pdf/", "/pdf%2F")},
    {canonicalUrl: row.canonicalUrl.replace("https://", "http://")},
    {canonicalUrl: row.canonicalUrl.replace("edge.naverncp.com", "example.com")},
    {canonicalUrl: note.canonicalUrl.replaceAll("%", "%25")},
    {canonicalUrl: row.canonicalUrl + "#spoof"},
    {revision: "local-substitution-preview"}, {revision: undefined},
    {canonicalUrl: row.canonicalUrl + "?spoof=1"}, {sourceGrade: "tier2"}, {sourceKind: "namu_document"},
    {content: row.content.slice(0, -1)}, {content: row.content + " 임의 해석"},
    {content: row.content.replace("투수", "포수")},
  ];
  const context = {question: "앞선 질문", answer: "검증되지 않은 과거 주장"};
  const request = buildRagLlmRequest("다시 설명해 줘", [row], RAG_OFFICIAL_SYSTEM_PROMPT, {context});
  const body = request.contents[0].parts[0].text;
  assert.ok(request.systemInstruction.parts[0].text.endsWith(OFFICIAL_INTERPRETATION_APPLICATION_PROMPT));
  assert.ok(body.indexOf("<출처 결속 해석 요약 —") > body.indexOf("<직전 대화 끝>"));
  assert.ok(body.indexOf("<출처 결속 해석 요약 끝>") < body.indexOf("질문: 다시 설명해 줘"));
  const summary = JSON.parse(officialInterpretationSummary([row, row]));
  assert.deepEqual(summary.evidence, [1, 2]);
  assert.equal(summary.interpretation, note.interpretation);
  assert.deepEqual(summary.scopedRules, note.scopedRules?.map(({clause, scope, meaning}) => ({clause, scope, meaning})));
  if (preamble) assert.ok(body.includes(preamble + row.content), "real request keeps scope before the unmodified raw chunk");
  assert.equal(buildRagLlmRequest("질문", [row], RAG_SYSTEM_PROMPT).systemInstruction.parts[0].text, RAG_SYSTEM_PROMPT);
  for (const mutation of mutations) {
    const changed = {...row, ...mutation};
    assert.equal(officialRuleInterpretation(changed), "");
    assert.equal(officialRuleScopePreamble(changed), "");
    assert.equal(officialInterpretationSummary([changed]), "");
    assert.equal(buildRagLlmRequest("질문", [changed], RAG_OFFICIAL_SYSTEM_PROMPT).systemInstruction.parts[0].text, RAG_OFFICIAL_SYSTEM_PROMPT);
  }
}
// Old infield source must be byte-for-byte unchanged by the new interpretation.
for (const line of fs.readFileSync("data/baseball-qa/kbo-rulebook-supplement-2026.jsonl", "utf8").trim().split("\n")) {
  const source = JSON.parse(line);
  assert.equal(officialRuleInterpretation({content: source.text, revision: audit.revision,
    canonicalUrl: notes[0].canonicalUrl, sourceGrade: "tier1", sourceKind: "kbo_ebook",
    pageTitle: source.title, sectionPath: source.section, asOf: "2026-11-04"}), "");
}
console.log("PASS: exact-source bindings, original/grounding preservation, stale/spoof/truncation mutations. Semantic live review still required.");
