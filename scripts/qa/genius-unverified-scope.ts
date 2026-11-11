/** Reviewer only: paired real model + answerQuestion, no DM/cache/DB writes.
 * --base-root=<exact 9eb4702 checkout> --out=<json>. Needs protected provider/DB access.
 * RAG/production delivery is NOT simulated as PASS: separate API/DM QA is required.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QaDeps } from '../../src/lib/baseball-qa/pipeline';
const cases = [
  { q: '야구 글로벌 임팩트가 뭐여', clarify: true },
  { q: '글로벌 임팩트가 뭐야', clarify: true },
  { q: '보크가 뭐야', source: 'dictionary' },
  { q: '포스트시즌이 뭐야', source: 'dictionary' },
  { q: '임창규 어떤 선수야', source: 'name_suggest' },
  { q: '야구 룰', source: 'scope_guide' },
  { q: '오늘 날씨 알려줘', source: 'blocked' },
  { q: '야구 말고 맛집 추천해줘', source: 'blocked' },
  { q: '홈런볼 과자 맛이 어때', source: 'blocked' },
] as const;
const arg = (name: string) => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
async function main() {
  const base = arg('base-root'), out = arg('out');
  if (!base || !out) throw new Error('--base-root and --out required');
  const rows: Record<string, unknown>[] = [];
  let failures = 0;
  const load = (root: string, file: string) => import(pathToFileURL(path.join(root, 'src/lib/baseball-qa', file)).href);
  const head = path.resolve(import.meta.dirname, '../..');
  const headServer = await load(head, 'server.ts');
  const roster = await load(head, 'roster/load-roster-players.ts');
  // Same read-only data snapshot for both sides; never substitute empty evidence for a failure.
  const glossary = await headServer.loadGlossary();
  const players = await roster.loadRosterPlayers();
  assert.ok(glossary.length >= 170 && players.length > 100, 'full current reference data required');
  for (const [variant, root] of [['base', base], ['head', head]]) {
    const server = await load(root, 'server.ts');
    const pipeline = await load(root, 'pipeline.ts');
    const term = await load(root, 'term-knowledge.ts');
    for (const c of cases) for (let repeat = 0; repeat < 3; repeat++) {
      const row: Record<string, unknown> = { variant, question: c.q, repeat };
      const calls: string[] = [];
      try {
        const deps: QaDeps = {
          loadGlossary: async () => glossary, loadPlayers: async () => players,
          getCache: async () => null, setCache: async () => {},
          reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => {},
          callLlm: async (...args) => { const r = await server.callLlm(...args); calls.push(r.text); return r; },
        };
        const result = await pipeline.answerQuestion('qa-unverified-scope-memory-only', c.q, deps);
        Object.assign(row, { source: result.source, answer: result.answer, calls });
        if ('clarify' in c) {
          row.clarified = result.answer === term.UNVERIFIED_TERM_ANSWER;
          if (variant === 'head') assert.equal(row.clarified, true, 'existing SSOT clarification required');
        } else {
          assert.equal(result.source, c.source);
          if (variant === 'head') {
            const prior = rows.find(x => x.variant === 'base' && x.question === c.q && x.repeat === repeat);
            assert.equal(result.source, prior?.source, 'base/head path parity');
            if (c.source !== 'blocked') assert.equal(result.answer, prior?.answer, 'deterministic control text parity');
          }
        }
        row.pass = true;
      } catch (error) { row.pass = false; row.error = error instanceof Error ? error.message : String(error); failures++; }
      rows.push(row); fs.writeFileSync(out, JSON.stringify({ coverage: 'real classifier + in-memory orchestration; RAG/API/DM not covered', rows }, null, 2));
    }
  }
  console.log(JSON.stringify({ rows: rows.length, failures }));
  assert.equal(failures, 0, 'retain failures; no selective retry');
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
