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
