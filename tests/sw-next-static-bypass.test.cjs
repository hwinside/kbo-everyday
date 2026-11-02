const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

function worker() {
  const handlers = {}, calls = { fetch: 0, cache: 0, deleted: [], claimed: 0 };
  const cache = { addAll: async () => {}, put: async () => {} };
  runInNewContext(readFileSync('public/sw.js', 'utf8'), {
    URL, Response,
    self: { addEventListener: (name, fn) => { handlers[name] = fn; },
      skipWaiting() {}, clients: { claim: async () => { calls.claimed++; } } },
    caches: { open: async () => { calls.cache++; return cache; },
      match: async () => { calls.cache++; return undefined; },
      keys: async () => ['kbo-everyday-v19', 'kbo-everyday-v20'],
      delete: async key => { calls.deleted.push(key); } },
    fetch: async () => { calls.fetch++; return new Response('ok'); },
  });
  return { handlers, calls };
}

test('Next immutable JS, CSS and fonts bypass SW entirely, with or without deployment query', async () => {
  const { handlers, calls } = worker();
  for (const path of ['/_next/static/chunks/abc.js', '/_next/static/chunks/abc.js?dpl=x&__kbo_chunk_retry=1', '/_next/static/css/abc.css', '/_next/static/media/font.woff2']) {
    let intercepted = false;
    handlers.fetch({ request: { method: 'GET', url: `https://keubo.fan${path}` }, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false, path);
  }
  assert.equal(calls.fetch, 0);
  assert.equal(calls.cache, 0);
});
test('existing API/auth exclusions and non-GET behavior remain intact', () => {
  const { handlers } = worker();
  for (const [method,path] of [['GET','/api/example.js'],['GET','/auth/example.js'],['POST','/asset.js']]) {
    handlers.fetch({ request: { method, url: `https://keubo.fan${path}` }, respondWith() { assert.fail(path); } });
  }
});
test('ordinary images and non-Next scripts still use existing fetch handling', async () => {
  const { handlers, calls } = worker();
  for (const path of ['/icon.png', '/other.js', '/_next/static-lookalike.js']) {
    let response;
    handlers.fetch({ request: { method: 'GET', url: `https://keubo.fan${path}` }, respondWith(p) { response = p; } });
    assert.equal((await response).status, 200);
  }
  assert.equal(calls.fetch, 3);
});
test('activation removes previous SW cache and claims pages; push handlers remain registered', async () => {
  const { handlers, calls } = worker();
  let done;
  handlers.activate({ waitUntil(p) { done = p; } });
  await done;
  assert.deepEqual(calls.deleted, ['kbo-everyday-v19']);
  assert.equal(calls.claimed, 1);
  assert.equal(typeof handlers.push, 'function');
  assert.equal(typeof handlers.notificationclick, 'function');
});
