import assert from 'node:assert/strict';
import test from 'node:test';
import { acquirePublisherLock, publisherRedisCommand } from '../src/lib/game/publisher-redis';

test('Redis failures cannot be mistaken for NX contention; logs omit sensitive data', async () => {
  const original = globalThis.fetch;
  const warn = console.warn;
  const logs: unknown[][] = [];
  console.warn = (...args) => { logs.push(args); };
  const cfg = { url: 'https://private.test', token: 'private-token' };
  try {
    for (const [response, expected] of [
      [() => Response.json({ result: 'OK' }), 'acquired'],
      [() => Response.json({ result: null }), 'held'],
      [() => new Response('private quota body', { status: 403 }), 'unavailable'],
      [() => Response.json({ error: 'private command error' }), 'unavailable'],
      [() => new Response('private invalid JSON'), 'unavailable'],
      [() => Response.json(null), 'unavailable'],
      [() => Response.json({}), 'unavailable'],
      [() => Response.json({ result: 0 }), 'unavailable'],
      [() => { throw new Error('private network error'); }, 'unavailable'],
    ] as const) {
      globalThis.fetch = async (_url, init) => {
        assert.deepEqual(JSON.parse(String(init?.body)), ['SET', 'private-key', 'private-lock', 'NX', 'PX', 20000]);
        return response();
      };
      assert.equal(await acquirePublisherLock('private-lock', 'private-key', 20000, cfg), expected);
    }
    assert.ok(JSON.stringify(logs).includes('403'));
    assert.ok(!JSON.stringify(logs).includes('private'));
    globalThis.fetch = async () => new Response('private', { status: 403 });
    assert.deepEqual(await publisherRedisCommand(['GET', 'private-key'], cfg), { ok: false });
    assert.equal(await acquirePublisherLock('t', 'k', 20000, null), 'unavailable');
  } finally { globalThis.fetch = original; console.warn = warn; }
});

test('three consumers retain their documented failure contracts on actual HTTP 403', async () => {
  const original = globalThis.fetch;
  const env = { ...process.env };
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-only';
  process.env.VERCEL_ENV = 'production';
  let fetches = 0;
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://redis.test', 'Redis failure must not trigger uncoordinated KBO fetching');
    fetches++;
    return new Response('plan limit', { status: 403 });
  };
  try {
    const { resetFeatureSwitchCache, isFeatureDisabled } = await import('../src/lib/config/runtime-switches');
    resetFeatureSwitchCache();
    assert.equal(await isFeatureDisabled('relay-events'), false);
    assert.equal(await isFeatureDisabled('game-summary'), false);
    const { loadKboLiveText } = await import('../src/lib/crawler/kbo-live-text');
    await assert.rejects(loadKboLiveText('20261103SSKT0', { allowStaleOnError: true }), /KBO cache HTTP error/);
    const { loadRecentCpuSnapshots, commitCpuSnapshot } = await import('../src/lib/admin/cpu-snapshot-store-redis');
    assert.equal(await loadRecentCpuSnapshots(), null);
    assert.deepEqual(await commitCpuSnapshot({ capturedAtMs: Date.now(), seriesFingerprint: 'test', totalSeconds: 10, idleSeconds: 5 }), { ok: false, wrote: false });
    assert.equal(fetches, 5);
  } finally { globalThis.fetch = original; process.env = env; }
});
