/** Developer regression: real hooks, abort-ignoring fetch/body/stream failures. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
import React from 'react';
import { createRoot } from 'react-dom/client';
import { withRequestDeadline, LIVE_REQUEST_TIMEOUT_MS, RELAY_REQUEST_TIMEOUT_MS } from '../src/lib/polling/request-deadline';

async function main() {
  const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  const { useLiveGame } = await import('../src/lib/hooks/useLiveGame');
  const { useGameRelay } = await import('../src/lib/hooks/useGameRelay');
  const { supabase } = await import('../src/lib/supabase/client');
  const channel = { on() { return this; }, subscribe() { return this; } };
  supabase.channel = (() => channel) as unknown as typeof supabase.channel;
  supabase.removeChannel = (async () => 'ok') as typeof supabase.removeChannel;
  const nativeTimeout = globalThis.setTimeout;
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  // Accelerate only production request deadlines, not React/poll scheduling.
  let deadlineMs = 100;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    nativeTimeout(fn, ms === LIVE_REQUEST_TIMEOUT_MS || ms === RELAY_REQUEST_TIMEOUT_MS ? deadlineMs : ms, ...args)
  ) as typeof setTimeout;
  Math.random = () => 0;
  const sleep = (ms: number) => new Promise<void>(r => nativeTimeout(r, ms));
  async function until(predicate: () => boolean, label: string) {
    const start = Date.now();
    while (!predicate() && Date.now() - start < 1500) await sleep(5);
    assert.ok(predicate(), label);
  }
  let hidden = false;
  Object.defineProperty(document, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' });
  const visibility = (value: boolean) => { hidden = value; document.dispatchEvent(new dom.window.Event('visibilitychange')); };
  const gameId = '20261004LTKT0';
  const payload = (name: string) => ({ games: [{ gameId, currentBatter: name, isLive: true }], trace: { sourceAtMs: Date.now(), fetchedAtMs: Date.now() } });
  const relayPayload = (name: string) => ({ gameId, innings: [], currentInning: 9, marker: name });
  const envelope = (channel: string, data: unknown) => JSON.stringify({ channel, ok: true, status: 200, data }) + '\n';
  let live!: ReturnType<typeof useLiveGame>;
  let relay!: ReturnType<typeof useGameRelay>;
  const onLiveFrame = (data: unknown) => embedded.push(data);
  let embedded: unknown[] = [];
  function Live({ interval = 20 }: { interval?: number }) {
    const result = useLiveGame(gameId, interval);
    React.useEffect(() => { live = result; });
    return null;
  }
  function Relay({ interval = 20, final = false }: { interval?: number; final?: boolean }) {
    const result = useGameRelay(gameId, !final, interval, 9, final, { onLiveFrame });
    React.useEffect(() => { relay = result; });
    return null;
  }
  let root: ReturnType<typeof createRoot> | undefined;
  const mount = (element: React.ReactElement) => { live = undefined!; relay = undefined!; hidden = false; const host = document.createElement('div'); document.body.append(host); root = createRoot(host); root.render(element); };
  const unmount = async () => { root?.unmount(); root = undefined; await sleep(10); document.body.replaceChildren(); };
  let passed = 0;
  const pass = (name: string) => { passed++; console.log('PASS', name); };
  try {
    const controller = new AbortController();
    await assert.rejects(withRequestDeadline(controller, () => new Promise(() => {}), 10), { name: 'AbortError' });
    assert.equal(controller.signal.aborted, true);
    pass('deadline settles even when operation ignores abort');

    for (const stall of ['headers', 'body']) {
      let calls = 0;
      let firstSignal: AbortSignal | null | undefined;
      globalThis.fetch = (async (_url, init) => {
        calls++;
        if (calls === 1) {
          firstSignal = init?.signal;
          if (stall === 'headers') return await new Promise<Response>(() => {});
          return { ok: true, json: () => new Promise(() => {}) } as Response;
        }
        return Response.json(payload('new'));
      }) as typeof fetch;
      mount(React.createElement(Live));
      await until(() => live?.game?.currentBatter === 'new', 'live recovery after ' + stall);
      assert.ok(firstSignal?.aborted);
      await unmount();
      pass('live hung ' + stall + ' times out and polling resumes');
    }

    deadlineMs = 1000;
    let calls = 0;
    let late!: (value: Response) => void;
    let oldSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_url, init) => {
      calls++;
      if (calls === 1) { oldSignal = init?.signal; return await new Promise<Response>(r => { late = r; }); }
      return Response.json(payload('fresh'));
    }) as typeof fetch;
    mount(React.createElement(Live, { interval: 10000 }));
    await until(() => calls === 1, 'first live request');
    visibility(true); visibility(false);
    await until(() => live?.game?.currentBatter === 'fresh', 'resume before deadline');
    assert.equal(calls, 2);
    assert.ok(oldSignal?.aborted);
    late(Response.json(payload('stale')));
    await sleep(25);
    assert.equal(live.game?.currentBatter, 'fresh');
    assert.equal(calls, 2);
    await unmount();
    pass('live visible resume is immediate/exactly once; late response discarded');

    deadlineMs = 100;
    calls = 0;
    let staleStream!: ReadableStreamDefaultController<Uint8Array>;
    globalThis.fetch = (async (url, init) => {
      calls++;
      if (calls === 1) {
        oldSignal = init?.signal;
        return new Response(new ReadableStream({ start(c) { staleStream = c; } }));
      }
      const data = relayPayload('fresh');
      return String(url).includes('game-relay-events') ? new Response(envelope('relay', data)) : Response.json(data);
    }) as typeof fetch;
    mount(React.createElement(Relay));
    await until(() => (relay?.data as unknown as { marker: string })?.marker === 'fresh', 'relay stream timeout recovers');
    assert.ok(oldSignal?.aborted);
    staleStream.enqueue(new TextEncoder().encode(envelope('relay', relayPayload('stale')) + envelope('live', payload('stale'))));
    staleStream.close();
    await sleep(20);
    assert.equal((relay.data as unknown as { marker: string }).marker, 'fresh');
    assert.equal(embedded.length, 0);
    await unmount();
    pass('relay hung stream recovers; late relay and embedded live frames discarded');

    deadlineMs = 1000;
    calls = 0;
    embedded = [];
    globalThis.fetch = (async (url, init) => {
      calls++;
      if (calls === 1) {
        oldSignal = init?.signal;
        return new Response(new ReadableStream({ start(c) { staleStream = c; } }));
      }
      return new Response(envelope('relay', relayPayload('resumed')) + envelope('live', payload('resumed')));
    }) as typeof fetch;
    mount(React.createElement(Relay, { interval: 10000 }));
    await until(() => calls === 1, 'relay first stream');
    visibility(true); visibility(false);
    await until(() => (relay?.data as unknown as { marker: string })?.marker === 'resumed', 'relay immediate resume');
    assert.ok(oldSignal?.aborted);
    assert.equal(calls, 2);
    assert.equal(embedded.length, 1);
    staleStream.close();
    await unmount();
    pass('relay visibility abort/re-request resumes before deadline');

    calls = 0;
    globalThis.fetch = (async (_url, init) => {
      calls++;
      if (calls === 1) { oldSignal = init?.signal; return await new Promise<Response>(() => {}); }
      return new Response(envelope('relay', relayPayload('final')) + envelope('events', { events: [] }));
    }) as typeof fetch;
    mount(React.createElement(Relay, { final: true }));
    await until(() => calls === 1, 'final first request');
    visibility(true); visibility(false);
    await until(() => (relay?.data as unknown as { marker: string })?.marker === 'final', 'final resume without retry interval');
    assert.ok(oldSignal?.aborted);
    assert.equal(calls, 2);
    await unmount();
    pass('final relay resumes aborted request immediately, preserving completion flow');

    calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json(payload('unexpected')); }) as typeof fetch;
    mount(React.createElement(Live, { interval: 0 }));
    await sleep(30);
    visibility(true); visibility(false);
    await sleep(30);
    assert.equal(calls, 0);
    await unmount();
    pass('disabled polling stays disabled on visibility resume');
    console.log(`${passed} regression cases passed`);
  } finally {
    await unmount();
    globalThis.setTimeout = nativeTimeout;
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
    await supabase.auth.stopAutoRefresh();
    supabase.realtime.disconnect();
    dom.window.close();
  }
}
// Supabase's imported browser singleton owns background timers unrelated to these hooks.
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
