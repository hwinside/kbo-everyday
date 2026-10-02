/** Reviewer-run diagnostic, not a blocking build gate or semantic PASS.
 * --out=/absolute/path --reps=3 [--supplement=/absolute/path.jsonl]
 * Supplement mode ranks locally embedded additions alongside real RPC results.
 * It is a pre-application experiment, NOT deployed retrieval or End-User QA.
 * No production accounts, conversations, logs, cache, or corpus writes.
 */
import fs from "node:fs";
import path from "node:path";
import { answerQuestion, type QaDeps } from "../../src/lib/baseball-qa/pipeline";
import { embedText } from "../../src/lib/baseball-qa/rag/embed";
import { buildRagLlmRequest, RAG_OFFICIAL_SYSTEM_PROMPT, RAG_DOCUMENT_CANDIDATE_LIMIT,
  RAG_DOCUMENT_MAX_DISTANCE, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";

const QUESTIONS = [
  "이사에서는 인필드 플라이가 없어?", "2아웃 만루에도 인필드플라이야?",
  ...["무사", "1사", "2사"].flatMap(outs => ["1루", "1·2루", "만루"].map(bases =>
    `${outs} ${bases}에서 내야수가 평범하게 잡을 수 있는 페어 플라이면 인필드플라이야?`)),
  "무사 만루 번트가 뜨면 인필드플라이야?", "1사 만루 직선타구도 인필드플라이야?",
  "인필드플라이가 선언되면 무조건 볼 데드야?",
  "아까 그 선수 왜 아웃이야?", "타격방해가 나오면 기본적으로 어떻게 판정돼?",
  "주자가 고의로 송구를 방해하면 아웃이야?", "DH는 무슨 약자야?",
];
const option = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const distance = (a: number[], b: number[]) => 1 - a.reduce((s, n, i) => s + n * b[i], 0)
  / Math.sqrt(a.reduce((s, n) => s + n * n, 0) * b.reduce((s, n) => s + n * n, 0));

async function main() {
  const out = option("out");
  const reps = Number(option("reps") ?? "3");
  if (!out || !path.isAbsolute(out) || !Number.isInteger(reps) || reps < 1 || reps > 5) throw new Error("absolute --out and reps 1..5 required");
  const server = await import("../../src/lib/baseball-qa/server");
  const production = server.makeDeps(0);
  const file = option("supplement");
  const additions: Array<{ evidence: RagEvidence; vector: number[] }> = [];
  if (file) {
    for (const line of fs.readFileSync(file, "utf8").trim().split("\n")) {
      const row = JSON.parse(line);
      const embedded = await embedText(row.text, "document", fetch, row.title);
      if (!embedded.ok) throw new Error(`supplement embedding: ${embedded.reason}`);
      additions.push({ vector: embedded.vector, evidence: {
        content: row.text, pageTitle: row.title, sectionPath: `${row.title}#${row.section}`,
        canonicalUrl: `https://6ptotvmi5753.edge.naverncp.com/KBO_FILE/ebook/pdf/${encodeURIComponent(row.file)}`,
        revision: "local-supplement-experiment", asOf: row.fetchedAt.slice(0, 10),
        sourceGrade: "tier1", sourceKind: "kbo_ebook",
      } });
    }
  }
  const runs: unknown[] = [];
  const save = () => fs.writeFileSync(out, JSON.stringify({ mode: file ? "local-ranked-supplement" : "production-read-only", reps, questions: QUESTIONS, runs }, null, 2));
  for (let rep = 0; rep < reps; rep++) for (const question of QUESTIONS) {
    const trace: unknown[] = [];
    const deps: QaDeps = {
      // Explicit read/model allowlist. Never spread makeDeps: it contains writes.
      loadGlossary: production.loadGlossary, loadPlayers: production.loadPlayers,
      normalizeQuestionLlm: production.normalizeQuestionLlm,
      mapGlossaryDefinition: production.mapGlossaryDefinition,
      reserveDaily: async () => ({ allowed: true, remaining: 9 }),
      getCache: async () => null, setCache: async () => {},
      log: async entry => { trace.push({ stage: "final-log", entry }); },
      searchOfficialRag: async query => {
        const baseline = await server.searchOfficialRag(query);
        let selected = baseline;
        if (additions.length) {
          const embedded = await embedText(query, "query");
          if (!embedded.ok) throw new Error(`query embedding: ${embedded.reason}`);
          if (baseline.some(e => typeof e.distance !== "number")) throw new Error("RPC distance missing");
          selected = [...baseline, ...additions.map(a => ({ ...a.evidence, distance: distance(embedded.vector, a.vector) }))]
            .filter(e => e.distance! <= RAG_DOCUMENT_MAX_DISTANCE)
            .sort((a, b) => a.distance! - b.distance!).slice(0, RAG_DOCUMENT_CANDIDATE_LIMIT);
        }
        trace.push({ stage: "retrieval", query, baseline, selected });
        return selected;
      },
      callOfficialRagLlm: async (q, evidence, extras) => {
        const raw = await server.callOfficialRagLlm(q, evidence, extras);
        trace.push({ stage: "official-generation", request: buildRagLlmRequest(q, evidence, RAG_OFFICIAL_SYSTEM_PROMPT, extras), raw });
        return raw;
      },
      callLlm: async (...args) => {
        const raw = await server.callLlm(...args);
        trace.push({ stage: "generic-generation", raw });
        return raw;
      },
    };
    const started = Date.now();
    try {
      const result = await answerQuestion("qa-local-infield", question, deps);
      runs.push({ rep, question, result, trace, elapsedMs: Date.now() - started });
    } catch (error) {
      runs.push({ rep, question, error: error instanceof Error ? error.name : "error", trace });
    }
    save();
  }
  console.log(`Saved ${runs.length} observations; semantic judgement required: ${out}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "diagnostic failed"); process.exitCode = 1; });
