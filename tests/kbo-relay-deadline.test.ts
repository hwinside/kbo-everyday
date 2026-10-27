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
