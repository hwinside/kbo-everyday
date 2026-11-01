import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://events-direct.test';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-only';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';

// Exercise the real GET, not the relay stream's separate deadline. A body reader
// ignoring cancellation must still be bounded by GET's 2700ms completion race.
test('direct GET bounds an uncooperative body read to 2.7 seconds', async () => {
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../src/app/api/game-events/route');
  const originalFetch = globalThis.fetch;
  let bodyStarted = false;
  let upstreamSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('GetKboGameList')) {
      return Response.json({ code: '100', game: [{
        G_ID: '20260901HTSS0', SR_ID: '0', GAME_STATE_SC: '2', CANCEL_SC_ID: '0',
        AWAY_NM: 'KIA', HOME_NM: '삼성', GAME_INN_NO: 3, GAME_TB_SC: 'T',
      }] });
    }
    if (url.includes('GetBoxScore')) {
      upstreamSignal = init?.signal;
      const response = Response.json({});
      response.json = () => {
        bodyStarted = true;
        return new Promise(() => {}); // Intentionally ignores abort.
      };
      return response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const startedAt = performance.now();
    const response = await Promise.race([
      GET(new NextRequest('https://test.local/api/game-events?gameId=20260901HTSS0')),
      new Promise<never>((_, reject) => {
        // 400ms scheduling tolerance, not an alternative product deadline.
        watchdog = setTimeout(() => reject(new Error('direct GET exceeded 2700ms budget + 400ms tolerance')), 3100);
      }),
    ]);
    assert.equal(bodyStarted, true, 'must reach the hanging body, not an early return');
    assert.ok(performance.now() - startedAt < 3100);
    assert.equal(upstreamSignal?.aborted, true);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      error: 'events_deadline_exceeded', events: [], currentState: null,
    });
  } finally {
    clearTimeout(watchdog);
    globalThis.fetch = originalFetch;
  }
});
