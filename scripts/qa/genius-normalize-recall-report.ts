/** Non-blocking recall observation; run once with a predeclared budget.
 * Usage: tsx scripts/qa/genius-normalize-recall-report.ts BASE_ROOT HEAD_ROOT OUT.json [60]
 * Environment must be loaded before invocation, like the shared latency harness.
 * Negative/wrong-candidate blocking remains in genius-question-normalize-live-smoke.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Server = typeof import("../../src/lib/baseball-qa/server");
type Pipeline = typeof import("../../src/lib/baseball-qa/pipeline");
type Roster = typeof import("../../src/lib/baseball-qa/roster/load-roster-players");
const cases = [
  ["폭추", "폭투"],
  ["싸이클링 히트", "사이클링 히트"],
  ["싸이클링 히트가 뭐야?", "사이클링 히트가 뭐야?"],
  ["야구장잔디는천연잔디야인조야", null],
] as const;
async function main() {
  const [baseRoot, headRoot, output, budget = "60"] = process.argv.slice(2);
  const rounds = Number(budget);
  assert.ok(baseRoot && headRoot && output && Number.isInteger(rounds) && rounds >= 30 && rounds <= 200);
  const variants = await Promise.all([baseRoot, headRoot].map(async root => {
    const moduleAt = (file: string) => import(pathToFileURL(resolve(root, `src/lib/baseball-qa/${file}.ts`)).href);
    const server = await moduleAt("server") as Server;
    const pipeline = await moduleAt("pipeline") as Pipeline;
    const roster = await moduleAt("roster/load-roster-players") as Roster;
    const [glossary, players] = await Promise.all([server.loadGlossary(), roster.loadRosterPlayers()]);
    assert.ok(glossary.length >= 100 && players.length >= 500);
    return { root: resolve(root), sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), server, pipeline, glossary, players };
  }));
  const rows: Array<{ round: number; question: string; variant: number; success: boolean; unsafe: boolean; candidate: string | null; error: boolean }> = [];
  for (let round = 0; round < rounds; round++) {
    for (const [index, [question, expected]] of cases.entries()) {
      // Alternate order within each paired observation; no adaptive retries.
      for (const variant of (round + index) % 2 ? [1, 0] : [0, 1]) {
        const v = variants[variant];
        try {
          const provider = await v.server.normalizeQuestionLlm(question, v.glossary);
          const decision = v.pipeline.resolveQuestionNormalization(question, provider, v.glossary, v.players);
          const candidate = decision.suggestionText ?? null;
          const success = expected === null
            ? v.pipeline.evaluateNormalizedCandidate(question, provider.text ?? "", v.glossary, v.players).status === "accepted_surface"
            : decision.suggested && candidate?.replace(/\s+/g, "") === expected.replace(/\s+/g, "");
          rows.push({ round, question, variant, success: Boolean(success), unsafe: decision.suggested && !success, candidate, error: false });
        } catch {
          rows.push({ round, question, variant, success: false, unsafe: false, candidate: null, error: true });
        }
      }
    }
  }
  const summary = cases.map(([question]) => {
    const counts = [0, 1].map(variant => {
      const subset = rows.filter(row => row.question === question && row.variant === variant);
      return { success: subset.filter(row => row.success).length, total: subset.length, unsafe: subset.filter(row => row.unsafe).length, errors: subset.filter(row => row.error).length };
    });
    return { question, base: counts[0], head: counts[1], delta: (counts[1].success - counts[0].success) / rounds };
  });
  writeFileSync(output, JSON.stringify({ variants: variants.map(({ root, sha }) => ({ root, sha })), rounds, summary, rows, note: "Fixed-budget descriptive comparison, not proof of equivalence. Errors count as misses; any errors or lower head recall require reviewer investigation. Never retry until green." }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
main().catch(() => { console.error("Recall report could not complete; no valid report."); process.exitCode = 1; });
