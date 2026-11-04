/** Reviewer-owned read-only paired corpus diagnostic. No writes/accounts/DM.
 * --live --out=/new/absolute.json [--reps=3]
 * Frozen per-query RPC results, baseline without new source vs local-ranked
 * supplemental evidence with exact-source notes. NOT deployed retrieval/UI QA.
 * Manually grade all answers and errors; a nonempty answer is not a PASS.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { answerQuestion, type QaDeps } from "../../src/lib/baseball-qa/pipeline";
import type { PreviousTurnRow } from "../../src/lib/baseball-qa/context";
import { embedText } from "../../src/lib/baseball-qa/rag/embed";
import { RAG_DOCUMENT_MAX_DISTANCE, RAG_DOCUMENT_CANDIDATE_LIMIT, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";
import { officialRuleInterpretation } from "../../src/lib/baseball-qa/rag/official-rule-interpretation";

const option = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
function distance(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) throw new Error("embedding dimensions differ");
  return 1 - a.reduce((s, n, i) => s + n * b[i], 0)
    / Math.sqrt(a.reduce((s, n) => s + n * n, 0) * b.reduce((s, n) => s + n * n, 0));
}
async function main() {
  const out = option("out"), reps = Number(option("reps") ?? 3);
  if (!process.argv.includes("--live") || !out || !path.isAbsolute(out) || fs.existsSync(out)
    || !Number.isInteger(reps) || reps < 1 || reps > 3) throw new Error("requires --live --out=new-absolute-path --reps=1..3");
  const root = path.resolve(import.meta.dirname, "../..");
  const fixture = fs.readFileSync(path.join(root, "scripts/qa/fixtures/genius-substitution-20261104.json"), "utf8");
  const corpus = fs.readFileSync(path.join(root, "data/baseball-qa/kbo-substitution-2026.jsonl"), "utf8");
  const audit = JSON.parse(fs.readFileSync(path.join(root, "data/baseball-qa/kbo-substitution-2026.audit.json"), "utf8"));
  const interpretations = fs.readFileSync(path.join(root, "src/lib/baseball-qa/rag/official-rule-interpretations.json"), "utf8");
  const cases: Array<{id: string; question: string; expected: string; previousTurn: PreviousTurnRow | null}> = JSON.parse(fixture);
  const server = await import("../../src/lib/baseball-qa/server");
  const production = server.makeDeps(0);
  const additions: Array<{evidence: RagEvidence; vector: number[]}> = [];
  for (const line of corpus.trim().split("\n")) {
    const row = JSON.parse(line);
    const embedded = await embedText(row.text, "document", fetch, row.title);
    if (!embedded.ok) throw new Error(`supplement embedding failed: ${embedded.reason}`);
    additions.push({vector: embedded.vector, evidence: {
      content: row.text, pageTitle: row.title, sectionPath: `${row.title}#${row.section}`,
      canonicalUrl: `https://6ptotvmi5753.edge.naverncp.com/KBO_FILE/ebook/pdf/${encodeURIComponent(row.file)}`,
      revision: audit.revision, asOf: row.fetchedAt.slice(0, 10),
      sourceGrade: "tier1", sourceKind: "kbo_ebook",
    }});
  }
  const snapshots = new Map<string, {baseline: RagEvidence[]; candidate: RagEvidence[]}>();
  const traces: unknown[] = [];
  const referenceTimeMs = Date.now();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {cwd: root, encoding: "utf8"}).trim();
  const save = () => fs.writeFileSync(out, JSON.stringify({sha, referenceTimeMs,
    scope: "baseline without new source vs local-ranked supplement + exact-source editorial interpretation; NOT deployed/UI PASS",
    fixtureSha256: digest(fixture), corpusSha256: digest(corpus), interpretationsSha256: digest(interpretations), cases, reps,
    planned: cases.length * reps * 2, completed: traces.length, snapshots: Object.fromEntries(snapshots), traces,
  }, null, 2), {mode: 0o600});
  for (let rep = 0; rep < reps; rep++) for (const sample of cases) {
    for (const variant of rep % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
      const trace: unknown[] = [];
      const deps: QaDeps = {
        // Explicit allowlist; never spread production dependencies (writes).
        now: () => referenceTimeMs,
        loadPreviousTurn: async () => sample.previousTurn,
        loadGlossary: production.loadGlossary, loadPlayers: production.loadPlayers,
        normalizeQuestionLlm: production.normalizeQuestionLlm,
        mapGlossaryDefinition: production.mapGlossaryDefinition,
        reserveDaily: async () => ({allowed: true, remaining: 9}),
        getCache: async () => null, setCache: async () => {},
        log: async entry => {trace.push({stage: "log", entry});},
        observeOfficialEvidence: bundle => {trace.push({stage: "official-evidence", bundle});},
        searchOfficialRag: async query => {
          if (!snapshots.has(query)) {
            const baseline = await server.searchOfficialRag(query);
            if (baseline.some(row => officialRuleInterpretation(row))) throw new Error("baseline already contains annotated candidate source");
            const embedded = await embedText(query, "query");
            if (!embedded.ok || baseline.some(e => !Number.isFinite(e.distance))) throw new Error("retrieval snapshot incomplete");
            const candidate = [...baseline, ...additions.map(a => ({...a.evidence, distance: distance(embedded.vector, a.vector)}))]
              .filter(e => e.distance! <= RAG_DOCUMENT_MAX_DISTANCE)
              .sort((a, b) => a.distance! - b.distance!).slice(0, RAG_DOCUMENT_CANDIDATE_LIMIT);
            snapshots.set(query, {baseline, candidate});
          }
          const selected = structuredClone(snapshots.get(query)![variant as "baseline" | "candidate"]);
          trace.push({stage: "retrieval", query, selected});
          return selected;
        },
        callOfficialRagLlm: async (q, evidence, extras) => {
          const raw = await server.callOfficialRagLlm(q, evidence, extras);
          trace.push({stage: "official-generation", question: q, evidence, extras, raw,
            interpretations: evidence.map(row => officialRuleInterpretation(row))}); return raw;
        },
        callLlm: async (...args) => {
          const raw = await server.callLlm(...args); trace.push({stage: "generic-generation", raw}); return raw;
        },
      };
      try {
        const result = await answerQuestion("qa-local-substitution", sample.question, deps);
        traces.push({rep, variant, id: sample.id, result, trace, grade: null});
      } catch (error) {
        traces.push({rep, variant, id: sample.id, error: error instanceof Error ? error.name : "Error", trace, grade: null});
      }
      save();
    }
  }
  console.log(`Saved ${traces.length} observations; independent semantic grading required.`);
}
void main().catch(error => {console.error(error instanceof Error ? error.name : "Error"); process.exitCode = 1;});
