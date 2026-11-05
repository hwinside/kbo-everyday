import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldSuppressPoll } from '../src/lib/game/relay-frames-client';
import { buildIncludeChannels } from '../src/lib/game/live-poll-stream';

test('publisher gap recovers relay AND live before the next minute, not every third watchdog', () => {
  let freshAt = 0;
  let pollIndex = 1; // initial fetch already established baseline
  const liveRefreshes: number[] = [];
  for (let now = 3000; now <= 27000; now += 3000) {
    if (shouldSuppressPoll({ lastRelayFreshAtMs: freshAt, nowMs: now, hasRelayBaseline: true })) continue;
    const channels = buildIncludeChannels({ pollIndex: pollIndex++, isLive: true, isFinal: false, watchdogFallback: true });
    if (channels.includes('live')) liveRefreshes.push(now);
    freshAt = now; // successful fallback response
  }
  assert.deepEqual(liveRefreshes, [9000, 18000, 27000]);
});

test('healthy realtime suppresses fallback, cold/failed baseline never suppresses', () => {
  for (let now = 3000; now <= 60000; now += 3000) {
    assert.equal(shouldSuppressPoll({ lastRelayFreshAtMs: now - 3000, nowMs: now, hasRelayBaseline: true }), true);
  }
  assert.equal(shouldSuppressPoll({ lastRelayFreshAtMs: 0, nowMs: 1, hasRelayBaseline: false }), false);
  assert.equal(shouldSuppressPoll({ lastRelayFreshAtMs: null, nowMs: 1, hasRelayBaseline: true }), false);
});

test('quiet successful fallback stays bounded at seven requests in a rolling minute', () => {
  for (let phase = 0; phase < 9000; phase += 1000) {
    let freshAt = -phase;
    let requests = 0;
    for (let now = 0; now < 60000; now += 3000) {
      if (shouldSuppressPoll({ lastRelayFreshAtMs: freshAt, nowMs: now, hasRelayBaseline: true })) continue;
      freshAt = now;
      requests++;
    }
    assert.ok(requests <= 7);
  }
});

test('cold polls and final games retain existing channel cadence; detail is not forced', () => {
  assert.deepEqual(buildIncludeChannels({ pollIndex: 1, isLive: true, isFinal: false }), []);
  assert.deepEqual(buildIncludeChannels({ pollIndex: 1, isLive: true, isFinal: false, watchdogFallback: true }), ['live']);
  assert.deepEqual(buildIncludeChannels({ pollIndex: 1, isLive: false, isFinal: true, watchdogFallback: true }), ['events']);
});
