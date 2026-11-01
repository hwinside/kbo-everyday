import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldAcceptRelaySnapshot } from '../src/lib/game/relay-snapshot-age';
test('last-good fills a cold screen, cannot rewind it, and accepts newer official corrections', () => {
  const old = '2026-11-01T05:00:00Z';
  const newer = '2026-11-01T05:01:00Z';
  assert.equal(shouldAcceptRelaySnapshot(null, old), true);
  assert.equal(shouldAcceptRelaySnapshot(newer, old), false);
  assert.equal(shouldAcceptRelaySnapshot(newer, undefined), false);
  assert.equal(shouldAcceptRelaySnapshot(old, newer), true);
  assert.equal(shouldAcceptRelaySnapshot(old, old), true);
});
