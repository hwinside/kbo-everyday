/** Reviewer-only #1641 diagnostic, not a product fix or factual PASS gate.
 * npx tsx scripts/qa/genius-standings-evidence.ts --out=/absolute/path.json
 * Uses production app-fact adapters alongside the old reduced topic harness.
 * No production job/cache/quota/log/demand callbacks are copied from makeDeps.
 */
import fs from 'node:fs';
import { answerQuestion, type QaDeps, type LlmResult } from '../../src/lib/baseball-qa/pipeline';
import { RAG_OFFICIAL_SYSTEM_PROMPT } from '../../src/lib/baseball-qa/rag/retrieve';
import * as server from '../../src/lib/baseball-qa/server';
import { BASEBALL_QA_GEMINI_MODEL } from '../../src/lib/baseball-qa/gemini-request';

async function main() {
  const out = process.argv.find(a => a.startsWith('--out='))?.slice(6);
  if (!out || !out.startsWith('/')) throw new Error('absolute --out required');
  const production = server.makeDeps(0); // Only explicitly selected read/provider seams below.
  const glossary = await server.loadGlossary();
  const rows: Record<string, unknown>[] = [];
  const save = () => fs.writeFileSync(out, JSON.stringify({
    issue: 1641, model: BASEBALL_QA_GEMINI_MODEL,
    verdict: 'HOLD_PENDING_INDEPENDENT_FACTUAL_REVIEW',
    scope: 'app-fact wiring comparison; not full production UI/DM parity', rows,
  }, null, 2));
  for (const lane of ['reduced-topic', 'app-facts-connected'] as const) {
    for (const question of ['kbo 순위 알려줘', '현재 KBO 순위 알려줘',
      '2025 KBO 순위 알려줘', '2025 KBO 정규시즌 최종 순위 알려줘', '2025 KBO 시범경기 순위 알려줘',
      'KBO 순위는 어떻게 정해?', '보크가 뭐야?']) {
      for (let repeat = 0; repeat < 3; repeat++) {
        let started = false, stored: LlmResult | null = null;
        const events: Record<string, unknown>[] = [];
        const row: Record<string, unknown> = { lane, question, repeat,
          at: new Date().toISOString(), events };
        rows.push(row);
        const deps: QaDeps = {
          loadGlossary: async () => glossary, loadPlayers: async () => [],
          getCache: async () => null, setCache: async () => {},
          reserveDaily: async () => ({ allowed: true, remaining: 9 }),
          log: async entry => { row.log = entry; },
          getLlmState: async () => ({ started, result: stored }),
          acquireLlmStart: async () => { started = true; return true; },
          storeLlm: async value => { stored = value; },
          callLlm: async (...args) => {
            const result = await server.callLlm(...args);
            events.push({ kind: 'generic-model', result }); save(); return result;
          },
          searchOfficialRag: async (...args) => {
            const evidence = await server.searchOfficialRag(...args);
            events.push({ kind: 'retrieval', evidence }); save(); return evidence;
          },
          callOfficialRagLlm: async (...args) => {
            // Preserve the exact passages after pipeline selection/truncation,
            // not only fingerprints or the larger retrieval candidate set.
            events.push({ kind: 'official-model-input', question: args[0], evidence: args[1], extras: args[2],
              request: server.buildProductionRagRequest(args[0], args[1], RAG_OFFICIAL_SYSTEM_PROMPT, args[2]) });
            save();
            const result = await server.callOfficialRagLlm(...args);
            events.push({ kind: 'official-model-output', result }); save(); return result;
          },
        };
        if (lane === 'app-facts-connected') {
          deps.loadGameConversation = async date => {
            const snapshot = await production.loadGameConversation!(date);
            events.push({ kind: 'app-snapshot', date, snapshot }); save(); return snapshot;
          };
          deps.callGameConversation = async input => {
            const result = await production.callGameConversation!(input);
            events.push({ kind: 'app-interpretation', input, result }); save(); return result;
          };
        }
        try {
          row.result = await answerQuestion('qa-standings-memory-only', question, deps);
          row.stored = stored;
        } catch (error) {
          // Provider errors may contain request URLs. Never serialize them.
          row.error = error instanceof Error ? error.name : 'UnknownError';
        }
        save();
      }
    }
  }
  // Completion only: no green factual assertion for either a hold or an answer.
  console.log(`Captured ${rows.length} rows; independent factual review required.`);
}
void main().catch(() => { console.error('Diagnostic failed; inspect the saved rows.'); process.exitCode = 1; });
