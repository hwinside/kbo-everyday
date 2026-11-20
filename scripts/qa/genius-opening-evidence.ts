/** Reviewer-run diagnostic, not a product fix or a factual PASS gate.
 * npx tsx scripts/qa/genius-opening-evidence.ts --now=2026-11-19T11:57:44Z --out=/absolute/report.json
 * Required provider/DB environment must be injected before import. No dotenv dump.
 */
import fs from "node:fs";
import path from "node:path";
import { answerQuestion, type QaDeps, type LlmResult } from "../../src/lib/baseball-qa/pipeline";
import { fallbackEligible } from "../../src/lib/baseball-qa/agent/fallback";
import { BASEBALL_QA_GEMINI_MODEL } from "../../src/lib/baseball-qa/gemini-request";

async function main() {
  const out = process.argv.find(arg => arg.startsWith("--out="))?.slice(6);
  const now = process.argv.find(arg => arg.startsWith("--now="))?.slice(6);
  if (!out || !path.isAbsolute(out) || !now || !Number.isFinite(Date.parse(now))) {
    throw new Error("absolute --out and valid --now required");
  }
  // Refuse overwrites; reports may be the only evidence from a previous run.
  const fd = fs.openSync(out, "wx", 0o600);
  fs.closeSync(fd);
  const rows: Record<string, unknown>[] = [];
  let failed = 0;
  const blockedRequests: { method: string; host: string; path: string }[] = [];
  const originalFetch = globalThis.fetch;
  const databaseOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin;
  const readRpcs = new Set(["search_baseball_genius_official_chunks_v2",
    "search_baseball_genius_official_chunks", "search_baseball_genius_news_articles"]);
  const kboReadOrigins = new Set(["https://www.koreabaseball.com", "http://www.koreabaseball.com"]);
  const kboReadPaths = new Set(["/ws/Main.asmx/GetKboGameList", "/ws/Main.asmx/GetKboGameDate"]);
  // App adapters can emit monitoring writes on failure. Block them too, before
  // constructing Supabase clients; never serialize query strings or headers.
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const read = (method === "GET" || method === "HEAD") && url.hostname !== "api.telegram.org";
    const model = method === "POST" && url.hostname === "generativelanguage.googleapis.com";
    const rpc = method === "POST" && url.origin === databaseOrigin
      && url.pathname.startsWith("/rest/v1/rpc/") && readRpcs.has(url.pathname.slice("/rest/v1/rpc/".length));
    const kboRead = method === "POST" && kboReadOrigins.has(url.origin)
      && kboReadPaths.has(url.pathname);
    if (!read && !model && !rpc && !kboRead) {
      blockedRequests.push({ method, host: url.hostname, path: url.pathname });
      throw new Error("diagnostic_write_or_unlisted_request_blocked");
    }
    return originalFetch(input, init);
  };
  const save = () => fs.writeFileSync(out, JSON.stringify({
    model: BASEBALL_QA_GEMINI_MODEL, referenceTime: now,
    verdict: "HOLD_PENDING_INDEPENDENT_REVIEW", expectedRows: 48, failed, blockedRequests,
    scope: "standalone questions, cold in-memory state, no user profile or UI/DM parity",
    agentFallbackEnabled: process.env.BASEBALL_GENIUS_AGENT_FALLBACK !== "0",
    rows,
  }, null, 2), { mode: 0o600 });
  save();
  const server = await import("../../src/lib/baseball-qa/server");
  const production = server.makeDeps(0); // NEVER spread this object: it includes writes.
  const glossary = await production.loadGlossary();
  const players = await production.loadPlayers();
  const year = new Date(Date.parse(now) + 9 * 3600000).getUTCFullYear();
  const cases = ["개막전 언제야?", "KBO 개막일 언제야?", `${year}년 KBO 정규시즌 개막일은 언제야?`,
    `${year + 1}년 KBO 정규시즌 개막일은 언제야?`, "내년 개막전 언제야?",
    "오늘 경기 일정 알려줘", "보크가 뭐야?", "야구 말고 날씨 알려줘"];
  for (const lane of ["reduced-topic", "connected-read-seams"] as const) {
    for (const question of cases) for (let repeat = 1; repeat <= 3; repeat++) {
      let started = false, stored: LlmResult | null = null;
      const events: Record<string, unknown>[] = [];
      let sequence = 0;
      const timeouts: { seam: string; eventIndex: number; sequence: number }[] = [];
      const row: Record<string, unknown> = { lane, question, repeat,
        fallbackEligible: fallbackEligible(question), startedAt: new Date().toISOString(), events };
      rows.push(row);
      const trace = <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
        async (...args: A): Promise<R> => {
          // These whitelisted seams receive only synthetic questions/public evidence.
          const eventIndex = events.length;
          const event: Record<string, unknown> = { name, input: args, startSequence: ++sequence };
          const seamStart = performance.now();
          events.push(event); save();
          try {
            const result = await fn(...args);
            event.result = result;
            event.status = "returned";
            return result;
          } catch (error) {
            event.error = error instanceof Error ? error.name : "UnknownError";
            event.status = event.error === "TimeoutError" ? "timeout" : "error";
            if (event.status === "timeout") timeouts.push({ seam: name, eventIndex, sequence: ++sequence });
            throw error;
          } finally {
            event.endSequence = ++sequence;
            event.elapsedMs = Math.round(performance.now() - seamStart);
            save();
          }
        };
      const deps: QaDeps = {
        now: () => Date.parse(now), loadGlossary: async () => glossary,
        loadPlayers: async () => lane === "connected-read-seams" ? players : [],
        getCache: async () => null, setCache: async () => {},
        reserveDaily: async () => ({ allowed: true, remaining: 9 }),
        log: async entry => { row.log = entry; },
        getLlmState: async () => ({ started, result: stored }),
        acquireLlmStart: async () => { started = true; return true; },
        storeLlm: async result => { stored = result; },
        callLlm: trace("generic-model", production.callLlm),
        searchOfficialRag: trace("official-retrieval", production.searchOfficialRag!),
        callOfficialRagLlm: trace("official-model", production.callOfficialRagLlm!),
        observeOfficialEvidence: bundle => { events.push({ name: "selected-official-evidence", bundle }); save(); },
      };
      if (lane === "connected-read-seams") {
        deps.loadGameConversation = trace("app-snapshot", production.loadGameConversation!);
        deps.callGameConversation = trace("app-interpretation", production.callGameConversation!);
        deps.loadPostseason = trace("postseason", production.loadPostseason!);
        deps.loadGameLineups = trace("lineups", production.loadGameLineups!);
        deps.mapGlossaryDefinition = trace("glossary-map", production.mapGlossaryDefinition!);
        deps.normalizeQuestionLlm = trace("normalization", production.normalizeQuestionLlm!);
        deps.enableNewsRag = production.enableNewsRag;
        deps.searchNewsRag = trace("news-retrieval", production.searchNewsRag!);
        deps.callNewsRagLlm = trace("news-model", production.callNewsRagLlm!);
        deps.agentFallback = trace("verified-fallback", production.agentFallback!);
        deps.observeAgentFallback = outcome => { events.push({ name: "fallback-outcome", outcome }); save(); };
      }
      try {
        row.result = await answerQuestion("qa-opening-memory-only", question, deps);
        row.stored = stored;
      } catch (error) {
        failed++;
        // Raw exceptions may include credentials or request URLs.
        row.error = error instanceof Error ? error.name : "UnknownError";
      }
      row.timeoutObserved = timeouts.length > 0;
      row.completion = row.error ? "threw" : "returned";
      row.timeoutContinuations = timeouts.map(timeout => ({
        ...timeout,
        subsequentSeams: events.filter(event => typeof event.startSequence === "number"
          && event.startSequence > timeout.sequence).map(event => ({
          name: event.name, status: event.status, startSequence: event.startSequence,
        })),
        verifiedFallbackEnteredAfterTimeout: events.some(event => event.name === "verified-fallback"
          && typeof event.startSequence === "number" && event.startSequence > timeout.sequence),
        pipelineReturnedAfterTimeout: !row.error,
        finalResult: row.result ?? null,
        finalError: row.error ?? null,
      }));
      save();
    }
  }
  console.log(`Captured ${rows.length}/48 rows; ${failed} thrown errors. Factual review still required.`);
  globalThis.fetch = originalFetch;
  if (failed || blockedRequests.length) process.exitCode = 1;
}
void main().catch(() => { console.error("Diagnostic incomplete; inspect saved report."); process.exitCode = 1; });
