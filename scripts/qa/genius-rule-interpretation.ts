/** Reviewer-owned binding/mutation checks; not a semantic correctness verdict. */
import assert from "node:assert/strict";
import fs from "node:fs";
import notes from "../../src/lib/baseball-qa/rag/official-rule-interpretations.json";
import { officialRuleInterpretation } from "../../src/lib/baseball-qa/rag/official-rule-interpretation";
import { officialModelEvidenceContent } from "../../src/lib/baseball-qa/rag/official-parenthetical-evidence";
import { annotationContentDigest } from "../../src/lib/baseball-qa/rag/official-parenthetical-structure.mjs";
import { sanitizeEvidenceContent, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";

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
  const row: RagEvidence = {content: source.text, revision: audit.revision, canonicalUrl: note.canonicalUrl,
    pageTitle: source.title, sectionPath: `${source.title}#${source.section}`, asOf: source.fetchedAt.slice(0, 10),
    sourceGrade: "tier1", sourceKind: "kbo_ebook"};
  const original = structuredClone(row);
  const rendered = officialModelEvidenceContent(row);
  assert.ok(rendered.startsWith(row.content), "original evidence must remain intact");
  assert.ok(rendered.includes(note.interpretation));
  assert.deepEqual(row, original, "rendering must not alter grounding/provenance input");
  assert.ok(officialRuleInterpretation({...row, content: sanitizeEvidenceContent(row.content, row)}), "actual serving sanitizer must preserve binding");
  const mutations: Partial<RagEvidence>[] = [
    {revision: "local-substitution-preview"}, {revision: undefined},
    {canonicalUrl: row.canonicalUrl + "?spoof=1"}, {sourceGrade: "tier2"}, {sourceKind: "namu_document"},
    {content: row.content.slice(0, -1)}, {content: row.content + " 임의 해석"},
    {content: row.content.replace("투수", "포수")},
  ];
  for (const mutation of mutations) assert.equal(officialRuleInterpretation({...row, ...mutation}), "");
}
// Old infield source must be byte-for-byte unchanged by the new interpretation.
for (const line of fs.readFileSync("data/baseball-qa/kbo-rulebook-supplement-2026.jsonl", "utf8").trim().split("\n")) {
  const source = JSON.parse(line);
  assert.equal(officialRuleInterpretation({content: source.text, revision: audit.revision,
    canonicalUrl: notes[0].canonicalUrl, sourceGrade: "tier1", sourceKind: "kbo_ebook",
    pageTitle: source.title, sectionPath: source.section, asOf: "2026-11-04"}), "");
}
console.log("PASS: exact-source bindings, original/grounding preservation, stale/spoof/truncation mutations. Semantic live review still required.");
