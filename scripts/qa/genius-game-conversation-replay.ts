/** Read-only, full answerQuestion replay. No account login, job/DM/quota/cache writes.
 * --live --input=<private log JSON> --snapshots=<dated app facts JSON> --out=<artifact>
 * Optional --base-root=<base worktree> runs the actual baseline pipeline as well.
 * snapshots: { "2026-09-30": { games:[...], favoriteTeams:{ "user-id":"team name" } } }
 * Every input row remains in output, including errors/refusals. Manual grading required.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { answerQuestion, type QaDeps, type QaResult } from "../../src/lib/baseball-qa/pipeline";
import type { ConversationGame } from "../../src/lib/baseball-qa/game-conversation";
import type { PreviousTurnRow } from "../../src/lib/baseball-qa/context";

type Row = { id: string; kst: string; user_id: string; q: string; a: string; mp: string };
type Snapshot = { games: ConversationGame[] | null; favoriteTeams?: Record<string, string>; source?: string; capturedAt?: string };
const arg = (name: string) => process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3);
async function main() {
  if (!process.argv.includes("--live") || !arg("input") || !arg("snapshots") || !arg("out")) {
    throw new Error("requires --live --input= --snapshots= --out=; no data is fetched implicitly");
  }
  const rows: Row[] = JSON.parse(fs.readFileSync(arg("input")!, "utf8"));
  const snapshots: Record<string, Snapshot> = JSON.parse(fs.readFileSync(arg("snapshots")!, "utf8"));
  const runners: Array<[string, typeof answerQuestion]> = [["head", answerQuestion]];
  if (arg("base-root")) {
    const base = await import(pathToFileURL(path.resolve(arg("base-root")!, "src/lib/baseball-qa/pipeline.ts")).href);
    runners.unshift(["base", base.answerQuestion]);
  }
  const output: unknown[] = [];
  for (const [variant, run] of runners) {
    // A changed response schema must be paired with its own provider/prompt.
    // Sharing head's provider with base would invalidate the comparison.
    const serverPath = variant === "base"
      ? path.resolve(arg("base-root")!, "src/lib/baseball-qa/server.ts")
      : path.resolve(import.meta.dirname, "../../src/lib/baseball-qa/server.ts");
    const { makeDeps } = await import(pathToFileURL(serverPath).href);
    const production: QaDeps = makeDeps(0); // No real user identity, write ports never copied.
    const previous = new Map<string, { row: Row; result: QaResult }>();
    for (const row of rows) {
      const start = Date.now();
      const date = row.kst.slice(0, 10);
      const now = Date.parse(row.kst.replace(" ", "T") + "+09:00");
      const snapshot = snapshots[date];
      const last = previous.get(row.user_id);
      const context: PreviousTurnRow | null = last ? {
        question: last.row.q, answer: last.result.answer ?? null, jobSource: last.result.source,
        answeredAt: last.row.kst.replace(" ", "T") + "+09:00", currentCreatedAt: new Date(now).toISOString(),
      } : null;
      let selector: unknown = null;
      // Deliberate read-port allowlist. Never spread makeDeps: it includes writes.
      const deps: QaDeps = {
        loadGlossary: production.loadGlossary, loadPlayers: production.loadPlayers,
        callLlm: production.callLlm, mapGlossaryDefinition: production.mapGlossaryDefinition,
        normalizeQuestionLlm: production.normalizeQuestionLlm,
        searchRag: production.searchRag, callRagLlm: production.callRagLlm,
        callTeamRagLlm: production.callTeamRagLlm, enablePlayerRag: production.enablePlayerRag,
        enableTeamRag: production.enableTeamRag, searchNewsRag: production.searchNewsRag,
        callNewsRagLlm: production.callNewsRagLlm, enableNewsRag: production.enableNewsRag,
        searchOfficialRag: production.searchOfficialRag, callOfficialRagLlm: production.callOfficialRagLlm,
        getCache: async () => null, setCache: async () => {}, log: async () => {},
        reserveDaily: async () => ({ allowed: true, remaining: 99 }),
        now: () => now, loadPreviousTurn: async () => context,
        loadGameConversation: async () => ({ games: snapshot.games, favoriteTeam: snapshot.favoriteTeams?.[row.user_id] ?? null }),
        callGameConversation: async (input) => {
          const result = await production.callGameConversation!(input);
          selector = { input, result };
          return result;
        },
      };
      // Both variants use their own copy implementation and the same local profile snapshot.
      {
        const { TEAMS } = await import("../../src/lib/constants/teams");
        const copyPath = variant === "base"
          ? path.resolve(arg("base-root")!, "src/lib/constants/baseball-genius-team-copy.ts")
          : path.resolve(import.meta.dirname, "../../src/lib/constants/baseball-genius-team-copy.ts");
        const { renderTeamFanCopy } = await import(pathToFileURL(copyPath).href);
        deps.pickTeamFanCopy = async () => renderTeamFanCopy(TEAMS.find((t) => t.name === snapshot.favoriteTeams?.[row.user_id])?.id ?? null, 0);
      }
      try {
        if (!snapshot || !Number.isFinite(now)) throw new Error("missing dated snapshot or timestamp");
        const result = await run("qa-game-conversation-replay", row.q, deps);
        previous.set(row.user_id, { row, result });
        output.push({ variant, id: row.id, question: row.q, originalAnswer: row.a, originalSource: row.mp,
          result, selector, elapsedMs: Date.now() - start, grade: null });
      } catch (error) {
        previous.delete(row.user_id); // Failure is a context barrier, never silently skip backwards.
        output.push({ variant, id: row.id, question: row.q, error: error instanceof Error ? error.name : "Error", elapsedMs: Date.now() - start, grade: null });
      }
      fs.writeFileSync(arg("out")!, JSON.stringify({ inputCount: rows.length, outputCount: output.length,
        scope: "read-only pipeline replay; dated schedule overlay; no cache/durable/UI; manually grade all rows", output }, null, 2));
    }
  }
  console.log(`Collected ${output.length} results. No quality PASS is implied.`);
}
void main().catch((error) => { console.error(error instanceof Error ? error.name : "Error"); process.exitCode = 1; });
