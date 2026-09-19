import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCases, validateManifest, requestFor, runCase, summarize } from './runner.mjs';

const row = { case_id: 'case-synthetic-1', task: 'citation', question: '희생플라이?', prior_turns: [], candidate_answer: '희생플라이는 타수에서 제외합니다.', evidence: ['희생플라이는 타수에 포함하지 않는다.'] };

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
