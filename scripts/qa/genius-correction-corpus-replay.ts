/** Reviewer-facing read-only controlled replay of recorded correction candidates.
 * --input=private.json --base-root=worktree --out=private.json --env-file=path
 * Candidate is held constant (including historical mistakes); live head provider
 * supplies only original-spelling assessment. This isolates eligibility changes,
 * NOT end-to-end generation recall or UI QA. No production write ports are used.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { QaDeps } from "../../src/lib/baseball-qa/pipeline";
const arg = (name: string) => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
type Row = { case_id: string; q: string; candidate: string; kst: string };
async function main() {
  if (!arg("input") || !arg("base-root") || !arg("out")) throw new Error("input/base-root/out required");
  if (arg("env-file")) process.loadEnvFile(arg("env-file"));
  const head = await import("../../src/lib/baseball-qa/pipeline");
  const base = await import(pathToFileURL(path.resolve(arg("base-root")!, "src/lib/baseball-qa/pipeline.ts")).href);
  const server = await import("../../src/lib/baseball-qa/server");
  const { loadRosterPlayers } = await import("../../src/lib/baseball-qa/roster/load-roster-players");
  const [glossary, players] = await Promise.all([server.loadGlossary(), loadRosterPlayers()]);
  if (glossary.length < 100 || players.length < 500) throw new Error("incomplete reference snapshot");
  const prior = arg("assessments") ? JSON.parse(fs.readFileSync(arg("assessments")!, "utf8")).output : [];
  const assessments = new Map<string, Awaited<ReturnType<typeof server.normalizeQuestionLlm>>>(prior.filter((x: { assessment?: unknown }) => x?.assessment).map((x: { case_id: string; assessment: unknown }) => [x.case_id, x.assessment]));
  const rows: Row[] = JSON.parse(fs.readFileSync(arg("input")!, "utf8"));
  const output: unknown[] = Array(rows.length);
  let cursor = 0, completed = 0;
  const save = () => fs.writeFileSync(arg("out")!, JSON.stringify({ scope: "controlled recorded-candidate replay; live original assessment; no writes/UI; manual grading required", completed, count: rows.length, glossaryCount: glossary.length, playerCount: players.length, output }, null, 2));
  async function worker() {
    for (;;) {
      const i = cursor++; if (i >= rows.length) return;
      const row = rows[i];
      try {
        const assessment = assessments.get(row.case_id) ?? await server.normalizeQuestionLlm(row.q);
        const variants = [];
        for (const [variant, run] of [["base", base.answerQuestion], ["head", head.answerQuestion]] as const) {
          let log: unknown = null, calls = 0;
          const deps: QaDeps = {
            loadGlossary: async () => glossary, loadPlayers: async () => players,
            getCache: async () => null, setCache: async () => {},
            reserveDaily: async () => ({ allowed: true, remaining: 99 }),
            log: async entry => { log = entry; },
            normalizeQuestionLlm: async () => { calls++; return { ...assessment, text: row.candidate }; },
            callLlm: async () => ({ text: '{"status":"UNSURE","answer":""}', inputTokens: 0, outputTokens: 0 }),
          };
          const result = await run("qa-controlled-correction", row.q, deps);
          variants.push({ variant, calls, result, log });
        }
        output[i] = { ...row, assessment, variants };
      } catch (error) {
        output[i] = { ...row, error: error instanceof Error ? error.message : String(error) };
      }
      completed++; save();
      if (completed % 20 === 0 || completed === rows.length) console.log(`${completed}/${rows.length} completed`);
    }
  }
  await Promise.all([worker(), worker(), worker()]); save();
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
