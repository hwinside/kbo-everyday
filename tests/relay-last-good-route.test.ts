import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://relay-last-good.test';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-only';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis-last-good.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-only';

test('real relay GET returns retained innings with degraded body/header, no-store and original timestamp', async () => {
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../src/app/api/game-relay/route');
  const { parseKboLiveText } = await import('../src/lib/crawler/kbo-live-text');
  const gameId = '20261027HTSS0';
  const v1 = readFileSync(new URL('./fixtures/kbo-live/view1.html', import.meta.url), 'utf8');
  const v2 = readFileSync(new URL('./fixtures/kbo-live/view2.html', import.meta.url), 'utf8');
  const snapshot = { ...parseKboLiveText(gameId, v1, v2), updatedAt: new Date(Date.now() - 600_000).toISOString() };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === process.env.UPSTASH_REDIS_REST_URL) {
      const args = JSON.parse(String(init?.body));
      return Response.json({ result: args[0] === 'GET' ? JSON.stringify(snapshot) : 'OK' });
    }
    throw new Error('all external sources offline');
  }) as typeof fetch;
  try {
    const response = await GET(new NextRequest(`https://test.local/api/game-relay?gameId=${gameId}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-kbo-relay-degraded'), '1');
    assert.match(response.headers.get('cache-control')!, /no-store/);
    const data = await response.json();
    assert.equal(data.degraded, true);
    assert.equal(data.updatedAt, snapshot.updatedAt);
    assert.equal(data.innings.length, 4);
    assert.equal(data.innings[1].plays[2].batterName, '구자욱');
  } finally { globalThis.fetch = original; }
});
