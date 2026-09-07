import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { buildRagLlmRequest, RAG_EVIDENCE_MAX_CHARS, RAG_OFFICIAL_SYSTEM_PROMPT, type RagEvidence } from "../../../src/lib/baseball-qa/rag/retrieve";
import { repairKnownOfficialRuleContext } from "../../../src/lib/baseball-qa/rag/official-rule-context";

const fixture = JSON.parse(readFileSync(new URL("./official-rule-appendix-2026.json", import.meta.url), "utf8"));
const migration = readFileSync(new URL("../../../supabase/migrations/20260907120000_baseball_terms_semantic_clarity.sql", import.meta.url), "utf8");

export async function verifyRuleSemantics() {
  const raw = fixture.evidence;
  const evidence: RagEvidence = {
    content: raw.content.slice(0, RAG_EVIDENCE_MAX_CHARS), pageTitle: raw.page_title,
    sectionPath: raw.section_path, sourceGrade: "tier1", sourceKind: "kbo_ebook",
    canonicalUrl: raw.canonical_url, revision: raw.revision, asOf: raw.as_of,
  };
  const snapshot = JSON.stringify(evidence);
  const request = buildRagLlmRequest("아웃되는 경우", [evidence], RAG_OFFICIAL_SYSTEM_PROMPT);
  const data = request.contents[0].parts[0].text;
  assert.match(data, /보칙 — 방해 발생 순간/);
  assert.match(data, /귀루 기준이며, 각 항목이 모두 아웃 사유라는 뜻은 아닙니다/);
  assert.doesNotMatch(data, /5\.09 아\s*웃 \(이어짐\)/);
  assert.equal(JSON.stringify(evidence), snapshot, "Do not mutate stored retrieval evidence");
  assert.ok(!request.systemInstruction.parts[0].text.includes("포수 또는 다른 야수"), "Rule data must stay outside system instructions");
  const fixed = repairKnownOfficialRuleContext(evidence, RAG_EVIDENCE_MAX_CHARS);
  assert.ok(fixed.content.length <= RAG_EVIDENCE_MAX_CHARS);
  assert.equal(fixed.canonicalUrl, evidence.canonicalUrl);
  assert.equal(fixed.revision, evidence.revision);
  assert.equal(fixed.sourceGrade, evidence.sourceGrade);
  assert.deepEqual(repairKnownOfficialRuleContext(fixed, RAG_EVIDENCE_MAX_CHARS), fixed, "Presentation repair is idempotent");
  for (const other of [
    { ...evidence, sourceGrade: "tier2" as const },
    { ...evidence, sourceKind: "namu_document" as const },
    { ...evidence, sourceKind: undefined },
    { ...evidence, pageTitle: "2025 공식야구규칙" },
    { ...evidence, content: "5.09 아웃 (이어짐)\n주자가 고의로 송구를 방해하면 아웃됩니다." },
    { ...evidence, content: evidence.content.replace("5.09 아 웃", "5.05 타자가 주자되기") },
  ]) assert.strictEqual(repairKnownOfficialRuleContext(other, RAG_EVIDENCE_MAX_CHARS), other, "Unidentified sources/clauses must not be reclassified");

  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE baseball_terms (term text PRIMARY KEY, answer text NOT NULL, aliases jsonb NOT NULL, marker text NOT NULL)");
    for (const [term, answer] of Object.entries(fixture.glossaryBefore)) {
      await db.query("INSERT INTO baseball_terms VALUES ($1, $2, $3::jsonb, 'preserved')", [term, answer, JSON.stringify([term + " alias"])]);
    }
    await db.exec("INSERT INTO baseball_terms VALUES ('unrelated', 'preserve me', '[]', 'untouched')");
    const before = await db.query<{ term: string; aliases: unknown; marker: string }>("SELECT term, aliases, marker FROM baseball_terms ORDER BY term");
    await db.exec(migration);
    const first = await db.query<{ term: string; answer: string }>("SELECT term, answer FROM baseball_terms ORDER BY term");
    for (const [term, answer] of Object.entries(fixture.glossaryAfter)) assert.equal(first.rows.find(r => r.term === term)?.answer, answer);
    assert.equal(first.rows.find(r => r.term === "unrelated")?.answer, "preserve me");
    assert.deepEqual((await db.query("SELECT term, aliases, marker FROM baseball_terms ORDER BY term")).rows, before.rows);
    await db.exec(migration);
    assert.deepEqual((await db.query("SELECT term, answer FROM baseball_terms ORDER BY term")).rows, first.rows, "Migration replay must be idempotent");
    await db.query("UPDATE baseball_terms SET answer = 'concurrent editorial change' WHERE term = $1", ["타격방해"]);
    const concurrent = (await db.query("SELECT * FROM baseball_terms ORDER BY term")).rows;
    await assert.rejects(db.exec(migration), /Unexpected glossary answer/, "Do not overwrite a concurrent editorial change");
    assert.deepEqual((await db.query("SELECT * FROM baseball_terms ORDER BY term")).rows, concurrent);
    await db.query("DELETE FROM baseball_terms WHERE term = $1", ["스윕"]);
    await assert.rejects(db.exec(migration), /Missing glossary term/);
    return first.rows.filter(r => r.term !== "unrelated").map(r => ({ ...r, aliases: [] as string[] }));
  } finally {
    await db.close();
  }
}
