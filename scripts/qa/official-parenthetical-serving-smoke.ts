/** Reviewer-run production request boundary checks. No DB/model calls. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildRagLlmRequest, RAG_OFFICIAL_SYSTEM_PROMPT, RAG_SYSTEM_PROMPT, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";
import { officialParentheticalNote } from "../../src/lib/baseball-qa/rag/official-parenthetical-evidence";
import sidecar from "../../src/lib/baseball-qa/rag/official-parenthetical-sidecar.json";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/official-parenthetical-serving.json", import.meta.url), "utf8"));
const sample = fixture.rows.find((x: { row: { section: string } }) => x.row.section.includes("40. INFIELD FLY"));
assert.ok(sample, "real serving definition 40 fixture required");
const row: RagEvidence = Object.freeze({
  content: sample.row.text, pageTitle: "2026 공식야구규칙", sectionPath: sample.row.section,
  canonicalUrl: sample.row.canonicalUrl, revision: sample.row.revision,
  sourceGrade: "tier1", sourceKind: "kbo_ebook", asOf: "2026-10-02",
});
const before = JSON.stringify(row);
const request = (r: RagEvidence, official = true) => buildRagLlmRequest(
  "내야 타구 질문", [r], official ? RAG_OFFICIAL_SYSTEM_PROMPT : RAG_SYSTEM_PROMPT,
).contents[0].parts[0].text;
const note = officialParentheticalNote(row);
assert.match(note, /제외 항목 A: 직선타구/);
assert.match(note, /제외 항목 B: 번트한 것이/);
assert.ok(request(row).includes(`${row.content}\n[원문 구조화 주석 — 파생 데이터]\n${note}`));
assert.equal(JSON.stringify(row), before, "guard/provenance evidence must not be mutated");
assert.doesNotMatch(request(row, false), /원문 구조화 주석/);
for (const delta of [
  { revision: `${row.revision}-stale` }, { canonicalUrl: `${row.canonicalUrl}?other=1` },
  { content: `${row.content}\n` }, { content: row.content.replace("직선타구", "다른타구") },
  { sourceKind: "wikipedia" }, { sourceGrade: "tier2" },
] as Partial<RagEvidence>[]) {
  const changed = { ...row, ...delta };
  assert.equal(officialParentheticalNote(changed), "", JSON.stringify(delta));
  assert.ok(request(changed).includes(changed.content), "stale annotation must retain original evidence");
  assert.doesNotMatch(request(changed), /원문 구조화 주석/);
}
const stored = sidecar.find(a => a.chunkId === sample.row.id)!;
const originalNote = stored.note;
stored.note = "FORGED RENDERED NOTE";
assert.equal(officialParentheticalNote(row), note, "render verified spans, not stored note text");
stored.note = originalNote;
const item = stored.structure.relations[0].items[0];
const originalQuote = item.quote;
item.quote = "FORGED SPAN";
assert.equal(officialParentheticalNote(row), "", "forged span must drop annotation");
item.quote = originalQuote;
assert.equal(officialParentheticalNote(row), note);
console.log("PASS: pure production request builder, original evidence preservation, source/version/span fail-closed");
