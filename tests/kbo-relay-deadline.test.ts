import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NextRequest } from 'next/server';

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://smoke.local';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'smoke-anon-key';

test('relay GET bounds a stalled Redis read and preserves request cancellation', async () => {
  const { GET } = await import('../src/app/api/game-relay/route');
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-only';
  try {
    for (const cancel of [false, true]) {
      let observed: AbortSignal | undefined;
      globalThis.fetch = (async (input, init) => {
        if (String(input) !== 'https://redis.test') throw new Error('offline fallback');
        observed = init?.signal as AbortSignal;
        return await new Promise<Response>((_resolve, reject) => {
          if (observed!.aborted) reject(observed!.reason);
          else observed!.addEventListener('abort', () => reject(observed!.reason), { once: true });
        });
      }) as typeof fetch;
      const controller = new AbortController();
      const reason = new Error('client disconnected');
      const request = new NextRequest('https://smoke.local/api/game-relay?gameId=20261027HTSS0', { signal: controller.signal });
      const started = Date.now();
      const response = GET(request);
      if (cancel) controller.abort(reason);
      const watchdog = setTimeout(() => controller.abort(new Error('test watchdog')), 4500);
      try { await response; } finally { clearTimeout(watchdog); }
      assert.ok(observed?.aborted, 'Redis receives a bounded signal');
      if (cancel) {
        assert.equal(observed.reason, reason);
        assert.ok(Date.now() - started < 1000, 'client cancellation must not wait for timeout');
      } else {
        assert.equal(observed.reason.name, 'TimeoutError');
        assert.ok(Date.now() - started < 4000, 'stalled KBO path must release before watchdog');
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  }
});

test('Redis-enabled relay caches KBO within snapshot lifetime and falls back on busy/failure', async () => {
  const { GET, parseInningRelays } = await import('../src/app/api/game-relay/route');
  const { parseKboLiveText } = await import('../src/lib/crawler/kbo-live-text');
  const { readFileSync } = await import('node:fs');
  const snapshot = parseKboLiveText('20261027HTSS0',
    readFileSync(new URL('./fixtures/kbo-live/view1.html', import.meta.url), 'utf8'),
    readFileSync(new URL('./fixtures/kbo-live/view2.html', import.meta.url), 'utf8'));
  const originalFetch = globalThis.fetch;
  const saved = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-only';
  try {
    for (const mode of ['fresh', 'near-expiry', 'busy', 'failure'] as const) {
      let naverCalls = 0;
      const gameId = mode === 'busy' ? '20260805LGSS0' : mode === 'failure' ? '20260806LGSS0' : snapshot.gameId;
      snapshot.updatedAt = new Date(Date.now() - (mode === 'near-expiry' ? 9500 : 0)).toISOString();
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url === 'https://redis.test') {
          if (mode === 'failure') throw new Error('Redis unavailable');
          const command = JSON.parse(String(init?.body));
          return Response.json({ result: mode === 'busy' ? null : command[0] === 'GET' ? JSON.stringify(snapshot) : null });
        }
        if (url.includes('api-gw.sports.naver.com')) {
          naverCalls++;
          return Response.json({ result: { textRelayData: { inn: 2, textRelays: snapshot.rows } } });
        }
        throw new Error('unexpected external request');
      }) as typeof fetch;
      const res = await GET(new NextRequest(`https://smoke.local/api/game-relay?gameId=${gameId}`));
      assert.equal(res.status, 200, mode);
      const body = await res.json();
      assert.ok(body.innings.length >= parseInningRelays(snapshot.rows).length);
      if (mode === 'fresh') {
        assert.equal(body.source, 'kbo');
        assert.match(res.headers.get('Cache-Control')!, /s-maxage=2/);
      } else if (mode === 'near-expiry') {
        assert.match(res.headers.get('Cache-Control')!, /no-store/);
      } else {
        assert.ok(naverCalls > 0, `${mode} must attempt Naver`);
        assert.match(res.headers.get('Cache-Control')!, /s-maxage=2/);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (saved.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = saved.url;
    if (saved.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = saved.token;
  }
});
