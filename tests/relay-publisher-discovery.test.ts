import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://publisher.test';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-only';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
const game = { G_ID: '20260901HTSS0', SR_ID: '0', GAME_STATE_SC: '2', AWAY_NM: 'KIA', HOME_NM: '삼성', CANCEL_SC_ID: '0' };

test('publisher accepts a 1.8s KBO response that exceeded the former primary deadline', async () => {
  const { listLiveGameIds } = await import('../src/lib/game/relay-live-publisher');
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (input, init) => {
      assert.ok(String(input).includes('GetKboGameList'), 'no unnecessary fallback');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 1800);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
      });
      return Response.json({ code: '100', game: [game] });
    }) as typeof fetch;
    assert.deepEqual(await listLiveGameIds('20260901'), [game.G_ID]);
  } finally { globalThis.fetch = original; }
});

test('source telemetry distinguishes HTTP/schema failure and Naver failure without error text', async () => {
  const { fetchKboLiveGames } = await import('../src/lib/notifications/kbo-live-games');
  for (const response of [new Response(null, { status: 503 }), Response.json({ broken: true })]) {
    const events: Array<{ source: string; outcome: string; elapsedMs: number }> = [];
    const result = await fetchKboLiveGames('20260901', Date.now() + 1000,
      (async () => response) as typeof fetch,
      async () => { throw new Error('sensitive upstream detail'); }, undefined, undefined,
      { observe: event => events.push(event) });
    assert.equal(result.ok, false);
    assert.ok(events.some(event => event.source === 'kbo-http'));
    assert.ok(events.some(event => event.source === 'naver' && event.outcome === 'fetch-or-budget-failed'));
    assert.ok(!JSON.stringify(events).includes('sensitive'));
  }
});

test('custom primary deadline aborts stalled I/O and retains fail-close', async () => {
  const { fetchKboLiveGames } = await import('../src/lib/notifications/kbo-live-games');
  let aborted = false;
  const events: Array<{ source: string; outcome: string }> = [];
  const upstream = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason); }, { once: true });
  })) as typeof fetch;
  const started = Date.now();
  const result = await fetchKboLiveGames('20260901', Date.now() + 1000, upstream,
    async () => { throw new Error('offline'); }, undefined, undefined,
    { kboBudgetMs: 250, observe: event => events.push(event) });
  assert.equal(aborted, true);
  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 800);
  assert.ok(events.some(event => event.source === 'kbo' && event.outcome === 'deadline'));
});
