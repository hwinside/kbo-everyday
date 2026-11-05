import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateCases, validateManifest, requestFor, runCase, summarize, parseIntervalMs, createPacedRunner, selectProvider, createDirectEvaluate, DIRECT_MODEL, safeRetryAfter } from './runner.mjs';

const row = { case_id: 'case-synthetic-1', task: 'citation', question: '희생플라이?', prior_turns: [], candidate_answer: '희생플라이는 타수에서 제외합니다.', evidence: ['희생플라이는 타수에 포함하지 않는다.'] };

test('provider selection is resolved once; explicit gateway overrides a direct key', () => {
  assert.equal(selectProvider(undefined, {}), 'gateway');
  assert.equal(selectProvider('auto', { TYPESAFE_API_KEY: 'test-key' }), 'direct');
  assert.equal(selectProvider('gateway', { TYPESAFE_API_KEY: 'test-key' }), 'gateway');
  assert.equal(selectProvider('direct', {}), 'direct');
  assert.throws(() => selectProvider('typo', {}), /INVALID_PROVIDER/);
  assert.throws(() => createDirectEvaluate(''), /TYPESAFE_AUTH_MISSING/);
});

const directResult = (extra = {}) => ({ model: DIRECT_MODEL, answers: { decision: {
  type: 'choice', choice: 'SUPPORTED', confidence: 0.8, probabilities: { SUPPORTED: 0.99 },
} }, ...extra });

test('direct HTTP wire contract uses pinned model, native confidence and abort signal only', async () => {
  let calls = 0;
  const evaluate = createDirectEvaluate('synthetic-key', async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-key');
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
    assert.equal(body.model, DIRECT_MODEL);
    assert.deepEqual(body.state, requestFor(row).state);
    assert.deepEqual(body.questions, requestFor(row).questions);
    return Response.json(directResult());
  });
  const result = await runCase(row, evaluate);
  assert.equal(result.provider_status, 'ok');
  assert.equal(result.confidence, 0.8);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes('synthetic-key'));
});

test('direct schema errors and model drift fail closed; missing confidence stays null', async () => {
  const answer = { type: 'choice', choice: 'SUPPORTED', probabilities: { SUPPORTED: 0.99 } };
  for (const payload of [directResult({ model: 'jev-other' }), {},
    directResult({ answers: { decision: { ...answer, type: 'noul' } } }),
    directResult({ answers: { decision: { ...answer, confidence: 2 } } }),
    directResult({ answers: { decision: { ...answer, choice: 'INVALID' } } })]) {
    const result = await runCase(row, createDirectEvaluate('test', async () => Response.json(payload)));
    assert.equal(result.provider_status, 'error');
    assert.equal(result.predicted_label, null);
  }
  const missing = await runCase(row, createDirectEvaluate('test', async () => Response.json(directResult({ answers: { decision: answer } }))));
  assert.equal(missing.provider_status, 'ok');
  assert.equal(missing.confidence, null);
  const invalidJSON = await runCase(row, createDirectEvaluate('test', async () => new Response('SECRET_BODY')));
  assert.equal(invalidJSON.provider_status, 'error');
  assert.ok(!JSON.stringify(invalidJSON).includes('SECRET'));
});

test('direct HTTP errors stop after one call and retain only allowlisted Retry-After', async () => {
  for (const status of [401, 429, 529]) {
    let calls = 0;
    const paced = createPacedRunner(1, createDirectEvaluate('test', async () => {
      calls++;
      return new Response('SECRET_BODY', { status, headers: { 'retry-after': '60', 'x-secret': 'SECRET_HEADER' } });
    }));
    const result = await paced(row);
    assert.equal(result.error_code, `HTTP_${status}`);
    assert.equal(result.retry_after, '60');
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    await assert.rejects(() => paced(row), /PACED_RUN_STOPPED/);
    assert.equal(calls, 1);
  }
  assert.equal(safeRetryAfter('Sun, 20 Sep 2026 00:00:00 GMT'), 'Sun, 20 Sep 2026 00:00:00 GMT');
  for (const value of [null, 'SECRET', '60 SECRET', '-1', '1.5', '999999999999999999']) assert.equal(safeRetryAfter(value), null);
});

test('direct timeout reaches fetch and never retries', async () => {
  let calls = 0;
  const evaluate = createDirectEvaluate('test', async (_, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => resolve(Response.json(directResult())), 1000);
      signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
    });
  });
  assert.equal((await runCase(row, evaluate, 10)).error_code, 'TIMEOUT');
  assert.equal(calls, 1);
});

test('ground truth and baseline never enter provider state; input fields are allowlisted', () => {
  validateCases([row]);
  const request = requestFor(row);
  assert.deepEqual(Object.keys(request.state).sort(), ['candidate_answer', 'evidence', 'prior_turns', 'question']);
  assert.equal(request.maxRetries, 0);
  assert.equal(request.providerOptions.gateway.zeroDataRetention, true);
  assert.throws(() => validateCases([{ ...row, gold_label: 'SUPPORTED' }]), /UNKNOWN_INPUT_FIELD/);
  assert.throws(() => validateCases([row, row]), /INVALID_CASE_ID/);
  assert.throws(() => validateCases([{ ...row, prior_turns: ['a', 'b', 'c'] }]), /INVALID_PRIOR_TURNS/);
});

test('missing native confidence stays null; selected probability is not substituted', async () => {
  const result = await runCase(row, async () => ({ answers: { decision: { choice: 'SUPPORTED', probabilities: { SUPPORTED: 0.99 } } }, response: { body: 'DO_NOT_STORE' } }));
  assert.equal(result.confidence, null);
  assert.equal(result.provider_status, 'ok');
  assert.deepEqual(Object.keys(result).sort(), ['case_id', 'predicted_label', 'confidence', 'latency_ms', 'provider_status', 'error_code'].sort());
  assert.ok(!JSON.stringify(result).includes('DO_NOT_STORE'));
});

test('invalid answers and HTTP failures never become predictions or expose bodies', async () => {
  const invalid = await runCase(row, async () => ({ answers: { decision: { choice: 'BASEBALL' } } }));
  assert.equal(invalid.provider_status, 'error');
  assert.equal(invalid.predicted_label, null);
  const failure = await runCase(row, async () => { throw Object.assign(new Error('SECRET_REQUEST_BODY'), { statusCode: 429 }); });
  assert.equal(failure.error_code, 'HTTP_429');
  assert.ok(!JSON.stringify(failure).includes('SECRET'));
  const timeout = await runCase(row, async () => { throw Object.assign(new Error('sensitive'), { name: 'TimeoutError' }); });
  assert.equal(timeout.error_code, 'TIMEOUT');
});

test('successful native confidence is persisted separately', async () => {
  const result = await runCase(row, async () => ({ answers: { decision: { choice: 'SUPPORTED' } }, providerMetadata: { typesafe: { confidence: { decision: 0.8 } } } }));
  assert.equal(result.confidence, 0.8);
});

function population() {
  const rows = [], cases = [], baseline = [];
  for (const task of ['baseball_scope', 'stat_intent', 'citation']) {
    for (let i = 0; i < 100; i++) {
      const case_id = `case-${task.replace('_', '-')}-${i}`;
      rows.push({ ...row, task, case_id, prior_turns: i < 20 ? ['야구 규칙 질문'] : [] });
      baseline.push({ case_id, current_label: null, stratum: ['failure_boundary'] });
      cases.push({ case_id, group_id: `group-${case_id}`, split: i < 50 ? 'tune' : 'holdout' });
    }
  }
  return { rows, baseline, manifest: { seed: 20260919, cases } };
}

test('real CLI resolves route, records direct provenance and checkpoints first 429 without fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-direct-cli-'));
  try {
    const { rows, manifest, baseline } = population();
    const input = rows.map(r => JSON.stringify(r)).join('\n');
    writeFileSync(join(dir, 'cases.jsonl'), input);
    writeFileSync(join(dir, 'baseline.jsonl'), baseline.map(r => JSON.stringify(r)).join('\n'));
    writeFileSync(join(dir, 'split.json'), JSON.stringify(manifest));
    // All HTTP calls are intercepted in this child, including accidental extra calls.
    writeFileSync(join(dir, 'mock.mjs'), `
      let calls = 0;
      globalThis.fetch = async (_, options) => {
        calls++;
        if (calls === 1) {
          const body = JSON.parse(options.body);
          return Response.json({model: body.model, answers: {decision: {
            type: 'choice', choice: Object.keys(body.questions.decision.criteria)[0], confidence: 0.6
          }}});
        }
        return new Response('PRIVATE_BODY', {status: 429, headers: {'retry-after': '120'}});
      };
    `);
    const args = [fileURLToPath(new URL('./runner.mjs', import.meta.url)),
      '--input', join(dir, 'cases.jsonl'), '--baseline', join(dir, 'baseline.jsonl'),
      '--manifest', join(dir, 'split.json'), '--split', 'tune', '--out', join(dir, 'run')];
    const env = { ...process.env, TYPESAFE_API_KEY: 'synthetic-only', AI_GATEWAY_API_KEY: '', VERCEL_OIDC_TOKEN: '' };
    const dry = spawnSync(process.execPath, [...args, '--provider', 'gateway'], { env, encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).provider, 'gateway');
    const liveArgs = [...args, '--live', '--interval-ms', '1', '--reviewed-input-sha256', createHash('sha256').update(input).digest('hex')];
    const child = spawnSync(process.execPath, ['--import', join(dir, 'mock.mjs'), ...liveArgs], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /LIVE_RUN_INCOMPLETE_SEE_STOPPED_JSON/);
    const run = JSON.parse(readFileSync(join(dir, 'run/run.json')));
    assert.equal(run.provider, 'direct');
    assert.equal(run.provider_selection, 'auto');
    assert.equal(run.model, DIRECT_MODEL);
    assert.equal(run.maxRetries, 0);
    assert.equal(run.automatic_fallback, false);
    const stopped = JSON.parse(readFileSync(join(dir, 'run/stopped.json')));
    assert.equal(stopped.completed_calls, 2);
    assert.equal(stopped.error_code, 'HTTP_429');
    assert.equal(stopped.retry_after, '120');
    assert.equal(existsSync(join(dir, 'run/summary.json')), false);
    const lines = readFileSync(join(dir, 'run/repeat-1.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).confidence, 0.6);
    assert.ok(!JSON.stringify({run, stopped, lines, stdout: child.stdout, stderr: child.stderr}).includes('PRIVATE'));
    assert.ok(!JSON.stringify(run).includes('synthetic-only'));
    const missing = spawnSync(process.execPath, [...liveArgs, '--provider', 'direct'], {
      env: { ...env, TYPESAFE_API_KEY: '' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /TYPESAFE_AUTH_MISSING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('full 300-case contract and group leakage are checked before calls', () => {
  const { rows, manifest, baseline } = population();
  validateCases(rows); validateManifest(rows, manifest, baseline);
  manifest.cases[50].group_id = manifest.cases[0].group_id;
  assert.throws(() => validateManifest(rows, manifest, baseline), /GROUP_LEAKAGE/);
});

test('quotas are checked from actual question/context and declared failure strata', () => {
  const { rows, manifest, baseline } = population();
  rows.filter(r => r.task === 'citation').forEach(r => { r.prior_turns = []; });
  assert.throws(() => validateManifest(rows, manifest, baseline), /MULTI_TURN_QUOTA/);
});

test('three-run consistency does not count failures as agreement; p95 includes failure time', () => {
  const ok = label => ({ predicted_label: label, provider_status: 'ok', latency_ms: 100 });
  const runs = [[ok('A'), ok('B')], [ok('A'), ok('C')], [ok('A'), { provider_status: 'error', latency_ms: 10000 }]];
  const summary = summarize(runs);
  assert.equal(summary.success_count, 5);
  assert.equal(summary.agreement_all_cases, 0.5);
  assert.equal(summary.agreement_complete_cases, 1);
  assert.equal(summary.p95_latency_ms, 10000);
});

test('routing-only stage accepts 200 cases without fabricated citation evidence', () => {
  const { rows, manifest, baseline } = population();
  const routing = rows.filter(r => r.task !== 'citation');
  const ids = new Set(routing.map(r => r.case_id));
  validateCases(routing);
  validateManifest(routing, { ...manifest, cases: manifest.cases.filter(r => ids.has(r.case_id)) }, baseline.filter(r => ids.has(r.case_id)));
  assert.throws(() => validateCases([{ ...routing[0], current_label: 'BASEBALL' }]), /UNKNOWN_INPUT_FIELD/);
});

for (const tasks of [
  ['baseball_scope'], ['stat_intent'], ['citation'],
  ['baseball_scope', 'citation'], ['stat_intent', 'citation'],
]) {
  test(`manifest rejects unsupported task set: ${tasks.join(',')}`, () => {
    const { rows, manifest, baseline } = population();
    const selected = rows.filter(r => tasks.includes(r.task));
    const ids = new Set(selected.map(r => r.case_id));
    validateCases(selected);
    assert.throws(() => validateManifest(
      selected,
      { ...manifest, cases: manifest.cases.filter(r => ids.has(r.case_id)) },
      baseline.filter(r => ids.has(r.case_id)),
    ), /INVALID_TASK_SET/);
  });
}


test('live pacing interval must be explicit, positive and timer-safe', () => {
  for (const value of [undefined, '', '0', '-1', '0.5', '1e3', ' 1000', 'Infinity', '2147483648']) {
    assert.throws(() => parseIntervalMs(value), /INVALID_INTERVAL_MS/);
  }
  assert.equal(parseIntervalMs('15000'), 15000);
  assert.equal(parseIntervalMs('2147483647'), 2147483647);
});

test('fixed completion-to-start gap crosses repeat boundaries without initial wait', async () => {
  const events = [];
  const paced = createPacedRunner(15000, async request => {
    assert.equal(request.maxRetries, 0);
    events.push('call');
    return { answers: { decision: { choice: 'SUPPORTED' } } };
  }, async ms => { events.push(`wait:${ms}`); });
  for (let repeat = 0; repeat < 3; repeat++) await paced(row);
  assert.deepEqual(events, ['call', 'wait:15000', 'call', 'wait:15000', 'call']);
});

test('429 stops paced runner without retry, fallback or subsequent sleep/call', async () => {
  let calls = 0, waits = 0;
  const paced = createPacedRunner(15000, async () => {
    calls++;
    if (calls === 2) throw Object.assign(new Error('PRIVATE'), { statusCode: 429 });
    return { answers: { decision: { choice: 'SUPPORTED' } } };
  }, async () => { waits++; });
  assert.equal((await paced(row)).provider_status, 'ok');
  assert.equal((await paced(row)).error_code, 'HTTP_429');
  await assert.rejects(() => paced(row), /PACED_RUN_STOPPED/);
  assert.equal(calls, 2);
  assert.equal(waits, 1);
});
