/** Reviewer-only paired probe. Exact clean worktrees via BASE_ROOT/HEAD_ROOT.
 * Protected env injection required. Isolated workers prevent cross-ref @/ imports.
 * No retries/discarded errors; glossary load/module startup excluded from timing.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const questions = [
  "낙아웃이 뭐야", "K가 뭐어", "스트라이크 조은가?", "보끄가 뭐야",
  "콜드", "삼성?", "아하", "내일은?", "홀드가 뭐여", "김도영홈런몇개",
];
async function worker() {
  const root = resolve(process.argv[3]);
  const server = await import(pathToFileURL(resolve(root, "src/lib/baseball-qa/server.ts")).href);
  const glossary = await server.loadGlossary();
  const start = performance.now();
  try {
    const result = await server.normalizeQuestionLlm(process.argv[4], glossary);
    console.log(JSON.stringify({ ms: performance.now() - start, result }));
  } catch (error) {
    console.log(JSON.stringify({ ms: performance.now() - start, error: error instanceof Error ? error.name : "Error" }));
  }
}
async function main() {
  if (process.argv[2] === "--worker") return worker();
  const roots = { base: process.env.BASE_ROOT, head: process.env.HEAD_ROOT };
  if (!roots.base || !roots.head) throw new Error("BASE_ROOT and HEAD_ROOT required");
  const variants = Object.entries(roots).map(([label, root]) => {
    const dir = resolve(root!);
    if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: dir, encoding: "utf8" }).trim()) {
      throw new Error(`${label}: tracked worktree must be clean`);
    }
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    return { label, sha, dir };
  });
  const rows: { variant: string; sha: string; question: string; round: number; ms: number; result?: unknown; error?: string }[] = [];
  for (let round = 0; round < 3; round++) {
    for (const question of questions) {
      for (const v of round % 2 === 0 ? variants : [...variants].reverse()) {
        const stdout = execFileSync(process.execPath, ["--import", "tsx", resolve(process.argv[1]), "--worker", v.dir, question], {
          cwd: v.dir, encoding: "utf8", timeout: 60000,
          env: { ...process.env, TSX_TSCONFIG_PATH: resolve(v.dir, "tsconfig.json") },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
        rows.push({ variant: v.label, sha: v.sha, question, round, ...result });
      }
    }
  }
  const summary = variants.map(v => {
    const all = rows.filter(r => r.variant === v.label);
    const times = all.filter(r => !r.error).map(r => r.ms).sort((a, b) => a - b);
    const quantile = (p: number) => times[Math.ceil(times.length * p) - 1] ?? null;
    return { variant: v.label, sha: v.sha, total: all.length, errors: all.filter(r => r.error).length,
      successP50: quantile(.5), successP95: quantile(.95) };
  });
  console.log(JSON.stringify({ metric: "normalization wall ms; glossary preloaded; paired order", summary, rows }, null, 2));
  if (rows.some(r => r.error)) process.exitCode = 1;
}
main().catch(() => { console.error("normalize-latency: setup/worker failure; no latency verdict"); process.exitCode = 1; });
