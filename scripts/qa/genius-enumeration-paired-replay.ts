/** Reviewer-run fixed-evidence generation experiment. No retrieval or pipeline QA claim.
 * One candidate generation per captured baseline official call; never retry.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { officialModelEvidenceContent } from "../../src/lib/baseball-qa/rag/official-parenthetical-evidence";
import { buildRagLlmRequest, RAG_OFFICIAL_SYSTEM_PROMPT, type RagEvidence, type RagLlmExtras } from "../../src/lib/baseball-qa/rag/retrieve";
const opt = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type Call = { stage: string; question: string; evidence: RagEvidence[]; extras?: RagLlmExtras; raw: unknown };
type Note = { canonicalUrl: string; sourceRevision: string; rawContentSha256: string; section: string; note: string };
async function main() {
  const input = opt("baseline"), manifest = opt("annotations"), out = opt("out");
  if (!input || !manifest || !out || !path.isAbsolute(out) || fs.existsSync(out)) throw new Error("baseline, annotations and new absolute out required");
  const baseline = JSON.parse(fs.readFileSync(input, "utf8"));
  if (baseline.mode !== "production-read-only" || baseline.reps !== 10
    || !["flyout-context", "flyout-regression"].includes(baseline.suite)
    || baseline.runs.length !== 10) throw new Error("complete 10-run flyout production baseline required");
  const notes: Note[] = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (!Array.isArray(notes) || notes.some(n => !n.sourceRevision || !n.section || !n.canonicalUrl
    || !/^[a-f0-9]{64}$/.test(n.rawContentSha256) || !n.note)) throw new Error("bound enumeration manifest required");
  const calls: Call[] = baseline.runs.flatMap((r: { trace: Call[] }) => r.trace.filter(c => c.stage === "official-generation"));
  if (calls.length > 20 || calls.some(c => !c.question || !Array.isArray(c.evidence))) throw new Error("invalid captured calls");
  const { callOfficialRagLlm } = await import("../../src/lib/baseball-qa/server");
  const runs: unknown[] = [];
  let exposed = 0;
  for (const call of calls) {
    const matched: number[] = [];
    const evidence = call.evidence.map((row, i) => {
      if (row.sourceKind !== "kbo_ebook" || row.sourceGrade !== "tier1") return row;
      const note = notes.find(n => n.canonicalUrl === row.canonicalUrl && n.sourceRevision === row.revision
        && n.section === row.sectionPath && n.rawContentSha256 === hash(row.content));
      if (!note) return row;
      matched.push(i);
      return { ...row, content: `${officialModelEvidenceContent(row)}\n[원문 구조화 주석 — 파생 데이터]\n${note.note}` };
    });
    if (matched.length) exposed++;
    const request = buildRagLlmRequest(call.question, evidence, RAG_OFFICIAL_SYSTEM_PROMPT, call.extras);
    try {
      const raw = await callOfficialRagLlm(call.question, evidence, call.extras);
      runs.push({ matched, baseline: call, request, raw });
    } catch (e) { runs.push({ matched, baseline: call, request, error: e instanceof Error ? e.name : "error" }); }
    fs.writeFileSync(out, JSON.stringify({ mode: "fixed-evidence-generation-only", suite: baseline.suite,
      plannedCalls: calls.length, exposed, runs }, null, 2));
  }
  if (!exposed) throw new Error("HOLD: no enumeration exposure; do not claim improvement");
  console.log(`Saved ${runs.length} paired generations; ${exposed} exposed; semantic judgement pending`);
}
main().catch(e => { console.error(e instanceof Error ? e.message : "replay failed"); process.exitCode = 1; });
