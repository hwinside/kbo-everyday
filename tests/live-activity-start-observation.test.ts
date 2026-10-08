import assert from 'node:assert/strict';
import test from 'node:test';
import { observeStartAttempt } from '../src/lib/notifications/live-activity-start-observation';
const context = { gameId: 'game', userId: 'test-user', pushToken: 'secret-token', env: 'production' as const };
test('attempt precedes send; accepted response correlates without leaking token', async () => {
  const events: Record<string, unknown>[] = [];
  const result = { ok: true, status: 200, invalidToken: false, apnsId: '00000000-0000-4000-8000-000000000000' };
  assert.equal(await observeStartAttempt(context, async () => {
    assert.equal(events[0].phase, 'attempted'); return result;
  }, e => events.push(e)), result);
  assert.equal(events[1].phase, 'accepted');
  assert.equal(events[0].attemptId, events[1].attemptId);
  assert.equal(events[1].apnsId, result.apnsId);
  assert.match(String(events[0].deviceKey), /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(events).includes(context.pushToken));
});
test('rejection and transport uncertainty remain distinct; raw errors are redacted', async () => {
  for (const status of [410, 0]) {
    const events: Record<string, unknown>[] = [];
    await observeStartAttempt(context, async () => ({ ok: false, status, invalidToken: status === 410,
      reason: status ? 'Unregistered' : 'transport /3/device/secret-token' }), e => events.push(e));
    assert.equal(events[1].phase, status ? 'rejected' : 'response_unknown');
    assert.equal(events[1].reason, status ? 'Unregistered' : 'unclassified_error');
    assert.ok(!JSON.stringify(events).includes(context.pushToken));
  }
});
test('throw is recorded unknown and propagated; logger failure cannot prevent send', async () => {
  const events: Record<string, unknown>[] = [];
  const error = new Error('secret-token');
  await assert.rejects(observeStartAttempt(context, async () => { throw error; }, e => events.push(e)), e => e === error);
  assert.equal(events[1].phase, 'response_unknown');
  assert.ok(!JSON.stringify(events).includes(context.pushToken));
  let sent = 0;
  await observeStartAttempt(context, async () => { sent++; return { ok: true, status: 200, invalidToken: false }; }, () => { throw error; });
  assert.equal(sent, 1);
});
test('inflight attempt has no fabricated result', async () => {
  const events: Record<string, unknown>[] = [];
  let finish!: () => void;
  const pending = observeStartAttempt(context, () => new Promise(resolve => {
    finish = () => resolve({ ok: true, status: 200, invalidToken: false });
  }), e => events.push(e));
  assert.deepEqual(events.map(e => e.phase), ['attempted']);
  finish(); await pending;
});

import { createStartAttemptBatch } from '../src/lib/notifications/live-activity-start-observation';
import { runStartSendChunks } from '../src/lib/notifications/live-activity-channel-policy';
import { randomUUID } from 'node:crypto';

test('2000 users including every sandbox retry fit request log limits, correlated before send', async () => {
  const lines: string[] = [];
  const observe = createStartAttemptBatch(line => lines.push(line));
  let sends = 0;
  await runStartSendChunks({
    items: Array.from({ length: 2000 }, () => randomUUID()), chunkSize: 100, claimChunkSize: 200,
    prepareChunk: async items => items, persistChunk: async () => {},
    sendOne: async userId => {
      for (const env of ['production', 'sandbox'] as const) {
        const result = await observe({ gameId: '20261007OBLG0', userId,
          pushToken: 'private-' + userId, env, channelId: 'a'.repeat(64) }, async () => {
          const before = lines.map(line => JSON.parse(line.slice(line.indexOf('{'))));
          assert.ok(before.some(batch => batch.phase === 'attempted' &&
            batch.rows.some((row: unknown[]) => row[0] === userId && batch.contexts[Number(row[2])][1] === env)));
          sends++;
          return { ok: env === 'sandbox', status: env === 'sandbox' ? 200 : 400,
            reason: env === 'sandbox' ? undefined : 'BadDeviceToken',
            invalidToken: env === 'production', apnsId: randomUUID() };
        });
        if (result.ok) break;
      }
    },
  });
  assert.equal(sends, 4000);
  assert.equal(lines.length, 80);
  const bytes = Buffer.byteLength(lines.join('\n'));
  assert.ok(bytes < 900_000, String(bytes)); // leave room for existing request logs
  assert.ok(!lines.join('').includes('private-'));
  for (let i = 0; i < lines.length; i += 2) {
    const parse = (line: string) => JSON.parse(line.slice(line.indexOf('{')));
    const attempts = parse(lines[i]); const results = parse(lines[i + 1]);
    assert.equal(attempts.batchId, results.batchId);
    assert.equal(attempts.rows.length, 100);
    assert.deepEqual(results.rows.map((row: unknown[]) => row[0]).sort((a: number,b: number) => a-b),
      Array.from({length: 100}, (_, index) => index));
  }
  console.log('2000 users / 4000 attempts:', lines.length, 'lines,', bytes, 'bytes');
});

test('batch cutoff is unknown; throws propagate; failed logger does not block sends', async () => {
  const lines: string[] = [];
  const observe = createStartAttemptBatch(line => lines.push(line));
  let finish!: () => void;
  const pending = observe(context, () => new Promise(resolve => {
    finish = () => resolve({ ok: true, status: 200, invalidToken: false });
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('attempted'));
  finish(); await pending;
  const error = new Error('secret-token');
  await assert.rejects(observe(context, async () => { throw error; }), value => value === error);
  assert.ok(lines[3].includes('response_unknown'));
  assert.ok(!lines.join('').includes('secret-token'));
  const broken = createStartAttemptBatch(() => { throw error; });
  assert.equal((await broken(context, async () => ({ ok: true, status: 200, invalidToken: false }))).ok, true);
});
