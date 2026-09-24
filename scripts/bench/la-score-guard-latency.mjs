/** Local latency experiment, not production latency or independent end-user QA.
 * Executes the actual legacy decision loop with injected RPC latencies.
 * Usage: node scripts/bench/la-score-guard-latency.mjs [baseline-sha]
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import ts from 'typescript';
const file = 'src/lib/notifications/live-activity.ts';
const current = readFileSync(file, 'utf8');
const sources = [['current', current]];
if (process.argv[2]) sources.unshift(['baseline', execFileSync('git', ['show', `${process.argv[2]}:${file}`], { encoding: 'utf8' })]);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
for (const [revision, source] of sources) {
  const start = source.indexOf('  const decisionByGame =');
  const end = source.indexOf('  let pushed = 0;', start);
  assert.ok(start >= 0 && end > start);
  const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const args = ['stateByGame', 'gameById', 'lastStateByGame', 'lastPlayByGame', 'buildContentState',
    'scoreStateOf', 'fullStateHashOf', 'observeLiveActivityScoreGuard', 'isScoreStateRetreat', 'decideChannelPush'];
  const run = new AsyncFunction(...args, code + ';return { decisions: decisionByGame.size, observations: scoreGuards.length };');
  for (const timeout of [false, true]) {
    let active = 0, peak = 0, calls = 0;
    const ids = Array.from({ length: 10 }, (_, i) => String(i));
    const observer = async () => {
      calls++; peak = Math.max(peak, ++active);
      if (timeout) {
        // Real AbortSignal timer, with the observer's fail-closed result injected.
        await new Promise(resolve => {
          const keepAlive = setTimeout(resolve, 1600);
          AbortSignal.timeout(1500).addEventListener('abort', () => { clearTimeout(keepAlive); resolve(); }, { once: true });
        });
      } else await new Promise(resolve => setTimeout(resolve, 20));
      active--;
      return { allowCorrection: false, blockedCount: 0, blockedMs: 0 };
    };
    const before = performance.now();
    const result = await run(new Map(ids.map(id => [id, 'live'])), new Map(ids.map(id => [id, { G_ID: id }])),
      new Map(ids.map(id => [id, { score: '1|0', hash: 'old' }])), undefined,
      () => ({}), () => '1|0', () => 'new', observer, () => false, () => ({ send: true }));
    const elapsedMs = Math.round(performance.now() - before);
    assert.deepEqual(result, { decisions: 10, observations: 10 });
    assert.equal(calls, 10, 'normal observations still reset probation');
    if (revision === 'current') { assert.equal(peak, 10); assert.ok(elapsedMs < (timeout ? 2500 : 1000)); }
    console.log(JSON.stringify({ revision, games: 10, injected: timeout ? '1500ms abort' : '20ms normal', elapsedMs, peak, ...result }));
  }
}
