import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readConfig, repliesTo, BOT_ID } from './lib/yajal-journey-contract.mjs';
const sha = 'a'.repeat(40);
const env = { QA_BASE_URL: 'https://example.test', QA_EXPECTED_SHA: sha, QA_TEST_USER_ID: 'test-user', QA_EMAIL: 'qa-journey@keubo.fan', QA_PASSWORD: 'fixture-only', QA_OUT: 'unused', NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fixture-only' };
const receipt = () => ({ origin: env.QA_BASE_URL, sha, checkedBy: 'reviewer', evidence: 'deployment-receipt.json', observedAt: new Date().toISOString() });
test('Doctor rejects stale/wrong deployment and non-test identity before actions', () => {
  assert.equal(readConfig(env, receipt()).appSha, sha);
  for (const patch of [{ sha: 'b'.repeat(40) }, { origin: 'https://wrong.test' }, { observedAt: '2020-01-01' }, { evidence: '' }]) assert.throws(() => readConfig(env, { ...receipt(), ...patch }));
  for (const patch of [{ QA_EMAIL: 'personal@example.com' }, { QA_REPLY_TIMEOUT_MS: 'NaN' }, { QA_BASE_URL: 'https://user:secret@example.test' }]) assert.throws(() => readConfig({ ...env, ...patch }, receipt()));
});
test('unrelated later bot row cannot stand in for an answer', () => {
  const rows = [{ id: 2, sender_id: BOT_ID, payload: { question_message_id: 999 } }, { id: 3, sender_id: 'someone-else', payload: { question_message_id: 1 } }, { id: 4, sender_id: BOT_ID, payload: { question_message_id: 1 } }];
  assert.deepEqual(repliesTo(rows, 1).map(r => r.id), [4]);
  assert.deepEqual(repliesTo(rows.slice(0, 2), 1), []);
});
test('pre-existing evidence directory is never modified on startup failure', async () => {
  const dir = await fs.mkdtemp(path.resolve('.yajal-contract-'));
  try {
    await fs.writeFile(path.join(dir, 'sentinel'), 'keep');
    const run = spawnSync(process.execPath, ['scripts/qa/yajal-user-journey.mjs'], { env: { PATH: process.env.PATH, QA_OUT: dir }, encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.deepEqual(await fs.readdir(dir), ['sentinel']);
    assert.equal(JSON.parse(run.stdout.trim()).verdict, 'NOT_EVALUATED');
  } finally { await fs.rm(dir, { recursive: true }); }
});
