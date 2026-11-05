// Reproduce with installed Next runtime, replacing only upstream/cache boundaries.
const assert = require('node:assert/strict');
const { createPatchedFetcher } = require('next/dist/server/lib/patch-fetch');
async function run(stale) {
  let transportSignal;
  let finish;
  const work = { route: '/api/game-detail', isStaticGeneration: false,
    incrementalCache: {
      generateCacheKey: async () => 'naver-preview',
      lock: async () => () => {},
      get: async () => ({ isStale: true, value: { kind: 'FETCH', revalidate: 60,
        data: { body: Buffer.from('{}').toString('base64'), status: 200, headers: {}, url: 'https://example.test/preview' } } }),
      set: async () => {},
    },
  };
  const patched = createPatchedFetcher(async (_url, init) => {
    transportSignal = init.signal;
    return new Promise(resolve => { finish = () => resolve(Response.json({ fresh: true })); });
  }, { workAsyncStorage: { getStore: () => work }, workUnitAsyncStorage: { getStore: () => undefined } });
  const controller = new AbortController();
  const result = patched('https://example.test/preview', { signal: controller.signal,
    ...(stale ? { next: { revalidate: 60 } } : { cache: 'no-store' }) });
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  if (stale) {
    assert.deepEqual(await (await result).json(), {});
    assert.equal(transportSignal, undefined, 'Next removes signal from stale refresh');
    assert.ok(Object.keys(work.pendingRevalidates).length > 0, 'unbounded refresh retained after payload returned');
  } else {
    assert.equal(transportSignal, controller.signal, 'no-store keeps transport cancellation');
    assert.equal(transportSignal.aborted, true);
    assert.equal(Object.keys(work.pendingRevalidates ?? {}).length, 0);
  }
  finish();
  await result;
  await Promise.all(Object.values(work.pendingRevalidates ?? {}));
}
run(true).then(() => run(false)).then(() => console.log('PASS: Next stale refresh loses deadline; no-store preserves it')).catch(e => { console.error(e); process.exitCode = 1; });
