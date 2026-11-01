import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import { createLivePollStream } from '../src/lib/game/live-poll-stream';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://events.test';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-only';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';

test('multiplex stream closes with explicit failure frames for stuck task and stuck body', async () => {
  for (const body of [false, true]) {
    let closed = false;
    const stuck = body ? Promise.resolve(new Response(new ReadableStream({ start() {} }))) : new Promise<Response>(() => {});
    const stream = createLivePollStream([
      { channel: 'relay', task: Promise.resolve(Response.json({ source: 'kbo' })) },
      { channel: 'events', task: stuck },
    ], { deadlineAtMs: Date.now() + 60, onClose: () => { closed = true; } });
    const frames = (await new Response(stream).text()).trim().split('\n').map(x => JSON.parse(x));
    assert.equal(frames.length, 2);
    assert.equal(frames[0].data.source, 'kbo');
    assert.equal(frames[1].ok, false);
    assert.equal(frames[1].status, 503);
    assert.equal(closed, true);
  }
});

test('actual events GET never calls Naver on valid KBO and bounds a stalled fallback', async () => {
  const { GET } = await import('../src/app/api/game-events/route');
  const original = globalThis.fetch;
  const row = { row: ['1', '중', '테스트', '삼진', '1', '0', '0', '0', '.250'].map(Text => ({ Text })) };
  try {
    for (const failBox of [false, true]) {
      let naverCalls = 0;
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url.includes('GetKboGameList')) return Response.json({ code: '100', game: [{ G_ID: '20260901HTSS0', SR_ID: '0', GAME_STATE_SC: '3', AWAY_NM: 'KIA', HOME_NM: '삼성', CANCEL_SC_ID: '0' }] });
        if (url.includes('GetBoxScore')) return Response.json(failBox ? {} : { tables: [{}, { rows: [row] }, { rows: [row] }, {}, {}] });
        if (url.includes('naver.com')) {
          naverCalls++;
          assert.ok(init?.signal);
          return await new Promise<Response>((_, reject) => {
            const signal = init!.signal!;
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        if (url.includes('events.test')) return Response.json({ prev_state: null, event_history: [] });
        throw new Error(`Unexpected URL ${url}`);
      }) as typeof fetch;
      const started = Date.now();
      const response = await GET(new NextRequest('https://events.test/api/game-events?gameId=20260901HTSS0'));
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.error, undefined);
      assert.ok(Date.now() - started < 3000);
      if (!failBox) assert.equal(naverCalls, 0);
      else assert.ok(naverCalls > 0);
    }
  } finally { globalThis.fetch = original; }
});

test('publisher discovers live games from KBO without Naver and fails closed on outage', async () => {
  const { listLiveGameIds } = await import('../src/lib/game/relay-live-publisher');
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async input => {
      assert.ok(String(input).includes('GetKboGameList'), 'valid KBO must not invoke Naver');
      return Response.json({ code: '100', game: [
        { G_ID: '20260901HTSS0', SR_ID: '0', GAME_STATE_SC: '2', AWAY_NM: 'KIA', HOME_NM: '삼성', CANCEL_SC_ID: '0' },
        { G_ID: '20260901LGOB0', SR_ID: '0', GAME_STATE_SC: '3', AWAY_NM: 'LG', HOME_NM: '두산', CANCEL_SC_ID: '0' },
      ] });
    }) as typeof fetch;
    assert.deepEqual(await listLiveGameIds('20260901'), ['20260901HTSS0']);
    globalThis.fetch = (async () => { throw new Error('both upstreams offline'); }) as typeof fetch;
    await assert.rejects(listLiveGameIds('20260901'), /discovery failed/);
  } finally { globalThis.fetch = original; }
});

test('actual combined GET finishes NDJSON within three seconds when every upstream stalls', async () => {
  const { GET } = await import('../src/app/api/game-relay-events/route');
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (_input, init) => await new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) as typeof fetch;
    const started = Date.now();
    const response = await GET(new NextRequest('https://events.test/api/game-relay-events?gameId=20260901HTSS0'));
    const frames = (await response.text()).trim().split('\n').map(x => JSON.parse(x));
    assert.ok(Date.now() - started < 3000);
    assert.deepEqual(frames.map(x => x.channel).sort(), ['events', 'relay']);
    assert.ok(frames.some(x => !x.ok));
  } finally { globalThis.fetch = original; }
});
