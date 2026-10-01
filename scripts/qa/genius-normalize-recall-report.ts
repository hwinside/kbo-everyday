/** Fixed-budget read-only answerQuestion comparison, with each revision's provider.
 * Usage: tsx scripts/qa/genius-normalize-recall-report.ts BASE_ROOT HEAD_ROOT OUT.json [60]
 * Load environment before invocation. No job/DM/quota/cache writes or real user account.
 * Positive recall is observational; unsafe candidates still block the separate live gate.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { QaDeps, QaResult } from "../../src/lib/baseball-qa/pipeline";

type Server = typeof import("../../src/lib/baseball-qa/server");
type Pipeline = typeof import("../../src/lib/baseball-qa/pipeline");
const cases = [
  ["폭추", "폭투", "폭투"],
  ["싸이클링 히트", "사이클링 히트", "사이클링 히트"],
  ["싸이클링 히트가 뭐야?", "사이클링 히트가 뭐야?", "사이클링 히트"],
] as const;
const key = (text: string) => text.replace(/\s+/g, "").toLowerCase();
async function main() {
  const [baseRoot, headRoot, output, budget = "60"] = process.argv.slice(2);
  const rounds = Number(budget);
  assert.ok(baseRoot && headRoot && output && Number.isInteger(rounds) && rounds >= 30 && rounds <= 200);
  const now = Date.now();
  const variants = await Promise.all([baseRoot, headRoot].map(async root => {
    const moduleAt = (file: string) => import(pathToFileURL(resolve(root, `src/lib/baseball-qa/${file}.ts`)).href);
    const server = await moduleAt("server") as Server;
    const pipeline = await moduleAt("pipeline") as Pipeline;
    // Both functions predate this PR. Abort before sampling if the adapter is incompatible.
    assert.equal(typeof pipeline.answerQuestion, "function");
    assert.equal(typeof server.makeDeps, "function");
    const production = server.makeDeps(0);
    const [glossary, players] = await Promise.all([production.loadGlossary(), production.loadPlayers()]);
    assert.ok(glossary.length >= 100 && players.length >= 500);
    // Explicit read-port allowlist: never spread makeDeps (it includes durable writes).
    const deps: QaDeps = {
      loadGlossary: async () => glossary, loadPlayers: async () => players,
      callLlm: production.callLlm, mapGlossaryDefinition: production.mapGlossaryDefinition,
      normalizeQuestionLlm: production.normalizeQuestionLlm,
      searchRag: production.searchRag, callRagLlm: production.callRagLlm,
      callTeamRagLlm: production.callTeamRagLlm, enablePlayerRag: production.enablePlayerRag,
      enableTeamRag: production.enableTeamRag, searchNewsRag: production.searchNewsRag,
      callNewsRagLlm: production.callNewsRagLlm, enableNewsRag: production.enableNewsRag,
      searchOfficialRag: production.searchOfficialRag, callOfficialRagLlm: production.callOfficialRagLlm,
      getCache: async () => null, setCache: async () => {}, log: async () => {},
      reserveDaily: async () => ({ allowed: true, remaining: 99 }),
      now: () => now, loadPreviousTurn: async () => null,
    };
    return { root: resolve(root), sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), pipeline, deps };
  }));
  const rows: Array<{ round: number; question: string; variant: number; success: boolean; unsafe: boolean; result: QaResult | null; error: boolean }> = [];
  for (let round = 0; round < rounds; round++) {
    for (const [index, [question, expected, term]] of cases.entries()) {
      for (const variant of (round + index) % 2 ? [1, 0] : [0, 1]) {
        const v = variants[variant];
        try {
          let providerFailed = false;
          const result = await v.pipeline.answerQuestion("qa-normalize-recall-report", question, {
            ...v.deps, // already restricted to read ports and local no-op writes
            log: async entry => {
              if ((entry.classifierObservation?.providerFailures ?? 0) > 0) providerFailed = true;
            },
          });
          const options = result.correctionOptions ?? [];
          const correctCard = result.source === "question_correction" && options.length === 1 && key(options[0]) === key(expected);
          const directDefinition = result.source === "dictionary" && key(result.term ?? "") === key(term);
          rows.push({ round, question, variant, success: correctCard || directDefinition,
            unsafe: result.source === "question_correction" && !correctCard,
            result, error: providerFailed || result.status >= 500 || result.source === "error" });
        } catch {
          rows.push({ round, question, variant, success: false, unsafe: false, result: null, error: true });
        }
      }
    }
  }
  // Runtime failures are not ordinary misses: an invalid run cannot claim base=0%.
  const valid = rows.every(row => !row.error);
  const summary = cases.map(([question]) => {
    const counts = [0, 1].map(variant => {
      const subset = rows.filter(row => row.question === question && row.variant === variant);
      return { success: subset.filter(row => row.success).length, total: subset.length,
        unsafe: subset.filter(row => row.unsafe).length, errors: subset.filter(row => row.error).length,
        rate: valid ? subset.filter(row => row.success).length / rounds : null };
    });
    return { question, base: counts[0], head: counts[1], delta: valid ? (counts[1].success - counts[0].success) / rounds : null };
  });
  writeFileSync(output, JSON.stringify({ valid, variants: variants.map(({ root, sha }) => ({ root, sha })), rounds, summary, rows,
    note: "Fixed-budget full answerQuestion replay; expected card or exact dictionary term counts as success. Other answers require manual grading. Any runtime errors invalidate all rates/deltas. Not proof of equivalence; never retry until green." }, null, 2));
  console.log(JSON.stringify({ valid, summary }, null, 2));
  if (!valid) process.exitCode = 1;
}
main().catch(() => { console.error("Recall report could not complete; no valid report."); process.exitCode = 1; });
