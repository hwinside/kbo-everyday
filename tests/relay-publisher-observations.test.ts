import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RelayInsertOutcome } from '../src/lib/game/relay-live-publisher';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://publisher.test';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-only';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';

const gameId = '20261103SSKT0';
const response = () => Promise.resolve(Response.json({ source: 'kbo' }));

test('live failure classes are distinguishable without bodies or exception text', async () => {
  const { createPublisherObservations, publishGameTick, newGameState, MAX_PAYLOAD_BYTES } = await import('../src/lib/game/relay-live-publisher');
  for (const mode of ['http', 'throw', 'json', 'oversize', 'inserted', 'error', 'stale', 'lock_busy', 'skipped'] as const) {
    const stats = createPublisherObservations();
    const rows: string[] = [];
    const result = await publishGameTick({
      date: '20261103', epoch: 1, observe: stats.observe,
      handlers: { relay: response, events: response, detail: response, live: async req => {
        assert.equal(req.nextUrl.origin, 'https://internal.local');
        assert.equal(req.nextUrl.searchParams.get('date'), '20261103');
        if (mode === 'http') return new Response('private body', { status: 503, headers: { 'X-Game-Live-Stage': 'starter-witness-failed' } });
        if (mode === 'throw') throw new Error('private exception');
        if (mode === 'json') return new Response('private malformed json');
        if (mode === 'oversize') return Response.json({ value: 'x'.repeat(MAX_PAYLOAD_BYTES) });
        return Response.json({ games: [gameId] });
      } },
      insertFrame: async row => { rows.push(row.kind); return row.kind === 'live' ? mode as RelayInsertOutcome : 'inserted'; },
    }, newGameState(), gameId, 0);
    const expected = mode === 'http' ? 'live:http-error:503:starter-witness-failed'
      : mode === 'throw' || mode === 'json' ? 'live:fetch-or-json-error' : `live:${mode}`;
    assert.equal(stats.counts[expected], 1, mode);
    if (['http', 'throw', 'json', 'oversize'].includes(mode)) assert.ok(!rows.includes('live'));
    if (mode === 'oversize') {
      assert.equal(result.skippedOversize, 1);
      assert.ok(stats.maxBytes.live > MAX_PAYLOAD_BYTES);
    }
    assert.ok(!JSON.stringify(stats).includes('private'));
    assert.ok(rows.includes('relay-full'), 'live failure must not block other channels');
  }
});

test('unchanged ticks aggregate into bounded counters and aborted ticks do not insert', async () => {
  const { createPublisherObservations, publishGameTick, newGameState } = await import('../src/lib/game/relay-live-publisher');
  const stats = createPublisherObservations();
  const state = newGameState();
  let inserts = 0;
  const deps = { date: '20261103', epoch: 1, observe: stats.observe,
    handlers: { relay: response, events: response, live: response, detail: response },
    insertFrame: async () => { inserts++; return 'inserted' as const; } };
  for (let tick = 0; tick < 30; tick++) await publishGameTick(deps, state, gameId, tick);
  assert.equal(stats.counts['live:inserted'], 1);
  assert.equal(stats.counts['live:unchanged'], 9);
  assert.equal(inserts, 4);
  const controller = new AbortController(); controller.abort();
  await publishGameTick(deps, state, gameId, 0, controller.signal);
  assert.equal(stats.counts['live:aborted'], 1);
  assert.equal(inserts, 4);
  assert.ok(Object.keys(stats.counts).length < 20);
});

test('unknown upstream stage is normalized, not copied into runtime logs', async () => {
  const { createPublisherObservations, publishGameTick, newGameState } = await import('../src/lib/game/relay-live-publisher');
  const stats = createPublisherObservations();
  await publishGameTick({ date: '20261103', epoch: 1, observe: stats.observe,
    handlers: { relay: response, events: response, detail: response,
      live: async () => new Response(null, { status: 500, headers: { 'X-Game-Live-Stage': 'private-value' } }) },
    insertFrame: async () => 'inserted',
  }, newGameState(), gameId, 0);
  assert.equal(stats.counts['live:http-error:500:other'], 1);
  assert.ok(!JSON.stringify(stats).includes('private-value'));
});

test('actual live handler called by publisher resolves witness against the synthetic origin and fails closed', async () => {
  const { gameLiveRoute } = await import('../src/app/api/game-live/route');
  const { internalGetRequest } = await import('../src/lib/game/relay-live-publisher');
  const original = globalThis.fetch;
  const calls: string[] = [];
  const id = '20260901HTSS0';
  try {
    globalThis.fetch = (async input => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.includes('Main.asmx')) return Response.json({ game: [{
        G_ID: id, GAME_STATE_SC: '1', CANCEL_SC_ID: '0', AWAY_NM: 'KIA', HOME_NM: '삼성',
        T_PIT_P_NM: '원정선발', B_PIT_P_NM: '홈선발',
      }] });
      if (url === 'https://internal.local/api/games?date=20260901') throw new TypeError('synthetic origin is not a routable service');
      throw new Error(`Unexpected mocked request: ${url}`);
    }) as typeof fetch;
    const response = await gameLiveRoute(internalGetRequest('/api/game-live', { date: '20260901', gameId: id }), {
      fetchKnownSlateIdsImpl: async () => [id],
    });
    assert.ok(calls.includes('https://internal.local/api/games?date=20260901'));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('X-Game-Live-Stage'), 'starter-witness-failed');
  } finally { globalThis.fetch = original; }
});

test('publisher live uses the cron origin for real witness validation, preserving fail-closed cases', async () => {
  const { gameLiveRoute } = await import('../src/app/api/game-live/route');
  const { publishGameTick, newGameState } = await import('../src/lib/game/relay-live-publisher');
  const original = globalThis.fetch;
  const id = '20260901HTSS0';
  const origin = 'https://publisher-preview.example';
  try {
    for (const mode of ['valid', 'missing-starter', 'wrong-slate', 'http-error', 'timeout'] as const) {
      const calls: string[] = [];
      const inserted: string[] = [];
      globalThis.fetch = (async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        calls.push(url);
        if (url.includes('Main.asmx')) return Response.json({ game: [{
          G_ID: id, GAME_STATE_SC: '1', CANCEL_SC_ID: '0', AWAY_NM: 'KIA', HOME_NM: '삼성',
          T_PIT_P_NM: '', B_PIT_P_NM: '',
        }] });
        assert.equal(url, `${origin}/api/games?date=20260901`);
        assert.ok(init?.signal, 'witness must keep its bounded abort signal');
        if (mode === 'http-error') return new Response(null, { status: 503 });
        if (mode === 'timeout') return await new Promise<Response>((_, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
        });
        return Response.json({ games: [{
          gameId: mode === 'wrong-slate' ? '20260901LGOB0' : id,
          awayStarterName: mode === 'missing-starter' ? '' : '원정선발', homeStarterName: '홈선발',
        }] });
      }) as typeof fetch;
      const started = Date.now();
      await publishGameTick({ date: '20260901', epoch: 1, liveRequestOrigin: origin,
        handlers: { relay: response, events: response, detail: response,
          live: req => gameLiveRoute(req, { fetchKnownSlateIdsImpl: async () => [id] }) },
        insertFrame: async row => { inserted.push(row.kind); return 'inserted'; },
      }, newGameState(), id, 0);
      assert.ok(calls.includes(`${origin}/api/games?date=20260901`));
      assert.equal(inserted.includes('live'), mode === 'valid', mode);
      assert.ok(inserted.includes('relay-full'), 'other channels remain independent');
      if (mode === 'timeout') assert.ok(Date.now() - started < 5500, 'route deadline is preserved');
    }
  } finally { globalThis.fetch = original; }
});

test('real-origin internal requests retain collector marking, date and cancellation without auth', async () => {
  const { internalGetRequest } = await import('../src/lib/game/relay-live-publisher');
  const { isCollectorRequest } = await import('../src/lib/game/collector-request');
  const controller = new AbortController();
  const req = internalGetRequest('/api/game-live', { date: '20261104' }, controller.signal, 'https://keubo.fan');
  assert.equal(req.url, 'https://keubo.fan/api/game-live?date=20261104');
  assert.equal(req.headers.get('authorization'), null);
  assert.ok(isCollectorRequest(req));
  controller.abort();
  assert.equal(req.signal.aborted, true);
});
