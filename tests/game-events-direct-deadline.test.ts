import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://events-direct.test';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = '***';
process.env.SUPABASE_SERVICE_ROLE_KEY = '***';

/**
 * 삼식 P1-1(2026-10-28): 스트림 상한이 대신 막아주는 바람에 `/api/game-events`
 * **직접 GET**의 기한은 사실상 무검증이었다(라우트 기한을 60초로 늘려도 GREEN).
 * 시작알림 watchdog처럼 이 라우트를 직접 부르는 쪽은 라우트 기한에 의존하므로,
 * 여기서는 스트림을 끼우지 않고 GET 핸들러만 직접 호출해 상한을 고정한다.
 * GAME_EVENTS_DEADLINE_MS를 늘리면 이 테스트는 실패해야 한다(mutation RED).
 */
test('direct game-events GET closes within its own deadline when Naver hangs', async () => {
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../src/app/api/game-events/route');
  const original = globalThis.fetch;
  let naverSignalSeen = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('GetKboGameList')) {
      return Response.json({ code: '100', game: [{
        G_ID: '20260901HTSS0', SR_ID: '0', GAME_STATE_SC: '2', CANCEL_SC_ID: '0',
        AWAY_NM: 'KIA', HOME_NM: '삼성', GAME_INN_NO: 3, GAME_TB_SC: 'T',
      }] });
    }
    // Empty box score forces the Naver record fallback — the path that hung in production.
    if (url.includes('GetBoxScore')) return Response.json({});
    if (url.includes('naver')) {
      naverSignalSeen = Boolean(init?.signal);
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const startedAt = Date.now();
    const res = await GET(new NextRequest('https://test.local/api/game-events?gameId=20260901HTSS0'));
    const elapsedMs = Date.now() - startedAt;
    assert.ok(res, 'the route must answer rather than hang');
    assert.ok(
      elapsedMs < 9_000,
      `direct GET must respect its own deadline, took ${elapsedMs}ms`,
    );
    assert.equal(naverSignalSeen, true, 'the Naver fallback must receive an abort signal');
  } finally {
    globalThis.fetch = original;
  }
});
