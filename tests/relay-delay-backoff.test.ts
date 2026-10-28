/** Developer self-check: actual React hook + transport, no live upstream. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { relayRetryDelayMs } from '../src/lib/game/relay-retry';
import { createLivePollStream } from '../src/lib/game/live-poll-stream';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

async function main() {
  assert.deepEqual([1, 2, 3, 4, 5, 20].map(n => relayRetryDelayMs(n)), [5000, 10000, 20000, 40000, 60000, 60000]);
  assert.equal(relayRetryDelayMs(1, '90'), 90000);
  assert.equal(relayRetryDelayMs(1, 'invalid'), 5000);
  assert.equal(relayRetryDelayMs(1, 'Tue, 27 Oct 2026 06:00:10 GMT', Date.parse('2026-10-27T06:00:00Z')), 10000);
  const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  const { useGameRelay } = await import('../src/lib/hooks/useGameRelay');
  const { supabase } = await import('../src/lib/supabase/client');
  const channel = { on() { return this; }, subscribe() { return this; } };
  supabase.channel = (() => channel) as unknown as typeof supabase.channel;
  supabase.removeChannel = (async () => 'ok') as typeof supabase.removeChannel;
  const realNow = Date.now, realRandom = Math.random, realFetch = fetch;
  let now = realNow();
  Date.now = () => now;
  Math.random = () => 0;
  const sleep = (ms = 20) => new Promise(r => setTimeout(r, ms));
  async function until(p: () => boolean) { for (let i = 0; i < 100 && !p(); i++) await sleep(5); assert.ok(p()); }
  let state!: ReturnType<typeof useGameRelay>;
  function Fixture({ id }: { id: string }) { const value = useGameRelay(id, true, 1000000); React.useEffect(() => { state = value; }); return null; }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let calls = 0;
  let mode: 'ok' | 'fail' | 'hold' = 'ok';
  let resolveLate!: (r: Response) => void;
  const response = (url: string, failed: boolean) => {
    const relay = failed ? Response.json({ error: 'relay_upstream_timeout' }, { status: 503, headers: { 'Retry-After': '12' } })
      : Response.json({ innings: [], marker: calls });
    return url.includes('game-relay-events')
      ? new Response(createLivePollStream([{ channel: 'relay', task: Promise.resolve(relay) }]), { headers: { 'Content-Type': 'application/x-ndjson' } })
      : relay;
  };
  globalThis.fetch = (async (url) => { calls++; if (mode === 'hold') return new Promise<Response>(r => { resolveLate = r; }); return response(String(url), mode === 'fail'); }) as typeof fetch;
  const tick = async (ms = 0) => { now += ms; document.dispatchEvent(new dom.window.Event('visibilitychange')); await sleep(); };
  try {
    root.render(React.createElement(Fixture, { id: '20261026HTSS0' }));
    await until(() => !!state?.data);
    const good = state.data;
    mode = 'fail';
    await tick(100000);
    await until(() => state.isDelayed);
    assert.equal(state.data, good, 'failure preserves last-good relay');
    const failedCalls = calls;
    await tick(11999); assert.equal(calls, failedCalls, 'Retry-After from stream prevents visibility retry');
    await tick(1); assert.equal(calls, failedCalls + 1);
    await tick(11999); assert.equal(calls, failedCalls + 1);
    await tick(1); assert.equal(calls, failedCalls + 2);
    await tick(19999); assert.equal(calls, failedCalls + 2, 'exponential delay exceeds Retry-After');
    mode = 'ok'; await tick(1); await until(() => !state.isDelayed);
    assert.notEqual(state.data, good);
    // New game's first (combined) request fails without inventing a baseline.
    mode = 'fail'; root.render(React.createElement(Fixture, { id: '20261027HTSS0' }));
    await until(() => state.isDelayed && state.data === null);
    const combinedCalls = calls;
    await tick(11999); assert.equal(calls, combinedCalls);
    await tick(1); assert.equal(calls, combinedCalls + 1, 'standalone retry after combined failure');
    await tick(11999); assert.equal(calls, combinedCalls + 1, 'standalone Retry-After honored');
    mode = 'ok'; await tick(1); await until(() => !state.isDelayed);
    // Late failure from A cannot poison B's successful response.
    mode = 'hold'; await tick(100000); await until(() => !!resolveLate);
    mode = 'ok'; root.render(React.createElement(Fixture, { id: '20261028HTSS0' }));
    await until(() => !!state.data && !state.isLoading);
    resolveLate(Response.json({ error: 'relay_upstream_timeout' }, { status: 503 }));
    await sleep(); assert.equal(state.isDelayed, false);
    console.log('PASS retry bounds/date parsing, stream + standalone Retry-After, last-good retention, exponential backoff, recovery, game reset, late failure fencing');
  } finally { root.unmount(); Date.now = realNow; Math.random = realRandom; globalThis.fetch = realFetch; dom.window.close(); }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
