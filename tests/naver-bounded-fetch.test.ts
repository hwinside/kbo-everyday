import assert from 'node:assert/strict';
import { fetchBoundedNaverResponse } from '../src/lib/crawler/naver-bounded-fetch';
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let now = originalNow();
Date.now = () => now;
let calls = 0;
let mode: 'ok' | 'fail' | 'hold' | 'body-hold' = 'ok';
let release: (() => void) | undefined;
const url = (key: string) => `https://example.test/${key}`;
const signal = () => new AbortController().signal;
globalThis.fetch = (async (_url, init) => {
  calls++;
  assert.equal(init?.cache, 'no-store');
  assert.equal((init as { next?: unknown }).next, undefined);
  assert.ok(init?.signal, 'transport is always bounded');
  if (mode === 'fail') return new Response('down', { status: 503 });
  if (mode === 'hold') await new Promise<void>(resolve => { release = resolve; });
  if (mode === 'body-hold') return new Response(new ReadableStream({
    start(controller) {
      init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true });
    },
  }));
  return Response.json({ count: calls });
}) as typeof fetch;
async function main() {
  const first = await fetchBoundedNaverResponse(url('ttl'), 30_000, signal());
  assert.deepEqual(await first.json(), { count: 1 });
  now += 29_999;
  assert.deepEqual(await (await fetchBoundedNaverResponse(url('ttl'), 30_000, signal())).json(), { count: 1 });
  assert.equal(calls, 1);
  now++;
  await fetchBoundedNaverResponse(url('ttl'), 30_000, signal());
  assert.equal(calls, 2, 'expired entry refreshes, not stale/background response');
  mode = 'hold';
  const a = new AbortController();
  const pa = fetchBoundedNaverResponse(url('shared'), 60_000, a.signal);
  const pb = fetchBoundedNaverResponse(url('shared'), 60_000, a.signal);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 3, 'preview/lineup in one request use one fetch');
  release!();
  assert.deepEqual(await (await pa).json(), { count: 3 });
  assert.deepEqual(await (await pb).json(), { count: 3 });
  mode = 'fail'; now += 30_001;
  await assert.rejects(fetchBoundedNaverResponse(url('ttl'), 30_000, signal()), /503/);
  const failedCalls = calls;
  await assert.rejects(fetchBoundedNaverResponse(url('ttl'), 30_000, signal()), /cooldown/);
  assert.equal(calls, failedCalls);
  now += 5000; mode = 'ok';
  await fetchBoundedNaverResponse(url('ttl'), 30_000, signal());
  assert.equal(calls, failedCalls + 1);
  const aborted = new AbortController(); aborted.abort(new Error('already aborted'));
  await assert.rejects(fetchBoundedNaverResponse(url('new'), 30_000, aborted.signal), /already aborted/);
  assert.equal(calls, failedCalls + 1, 'no work for already-aborted caller');
  mode = 'body-hold';
  const started = performance.now();
  await assert.rejects(fetchBoundedNaverResponse(url('body'), 30_000, AbortSignal.timeout(80)), /timeout/i);
  assert.ok(performance.now() - started < 500, 'transport timeout covers body completion');
  console.log('PASS: TTL, no stale refresh, single-flight, shared absolute deadline, cooldown/recovery, body timeout');
}
const keepAlive = setInterval(() => {}, 1000);
main().finally(() => { clearInterval(keepAlive); globalThis.fetch = originalFetch; Date.now = originalNow; }).catch(e => { console.error(e); process.exitCode = 1; });
