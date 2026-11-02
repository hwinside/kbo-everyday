// Local browser/runtime contract test, no production account or service involved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const { readFileSync } = require('node:fs');
const http = require('node:http');
const { webkit } = require('playwright');

async function run({ permanent = false, mutation = '' } = {}) {
  let source = readFileSync('src/lib/chunk-network-retry.ts', 'utf8');
  if (mutation === 'propagation') source = source.replace('event.stopImmediatePropagation();', '');
  if (mutation === 'forward') source = source.replace('script.dispatchEvent(failure);', '');
  const helper = (await build({ stdin: { contents: source, loader: 'ts' }, bundle: true,
    write: false, format: 'iife', globalName: 'recovery' })).outputFiles[0].text;
  const runtime = readFileSync('tests/fixtures/turbopack-16.1.6-runtime.js', 'utf8');
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/_next/')) {
      requests.push(req.url);
      res.setHeader('Content-Type', 'application/javascript');
      if (requests.length === 1 || permanent) {
        res.writeHead(503); res.end('Offline');
      } else {
        // Production chunks identify themselves by currentScript, NOT a hardcoded key.
        res.end("TURBOPACK.push([document.currentScript, 2, c => c.v('restored')]);");
      }
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<script>
      window.TURBOPACK=[]; window.TURBOPACK_CHUNK_SUFFIX='?dpl=original';
      ${runtime.slice(runtime.indexOf('(()=>{let e;'))}
      ${helper}
      recovery.acquireChunkNetworkRetry();
      TURBOPACK.push(['static/chunks/entry.js',1,c=>{
        window.load=()=>c.L('/_next/static/chunks/fixture.js?dpl=original').then(()=>c.r(2));
      }]);
      TURBOPACK.push(['static/chunks/boot.js',{otherChunks:[],runtimeModuleIds:[1]}]);
      </script>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    browser = await webkit.launch();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const outcome = await page.evaluate(() => Promise.race([
      load().then(value => ({ value }), error => ({ error: String(error) })),
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 4000)),
    ]));
    return { outcome, requests };
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
}

test('WebKit: transient failure requests again and registers the ORIGINAL import without navigation', { timeout: 15000 }, async () => {
  const { outcome, requests } = await run();
  assert.deepEqual(outcome, { value: 'restored' });
  assert.equal(requests.length, 2);
  assert.match(requests[1], /\?dpl=original&__kbo_chunk_retry=1$/);
});
test('WebKit: persistent failure rejects after exactly one retry', { timeout: 15000 }, async () => {
  const { outcome, requests } = await run({ permanent: true });
  assert.match(outcome.error, /Failed to load chunk/);
  assert.equal(requests.length, 2);
});
test('mutation: missing stopImmediatePropagation rejects original import instead of recovering', { timeout: 15000 }, async () => {
  const { outcome } = await run({ mutation: 'propagation' });
  assert.match(outcome.error, /Failed to load chunk/);
});
test('mutation: missing failure forwarding is detected by bounded settlement timeout', { timeout: 15000 }, async () => {
  const { outcome, requests } = await run({ permanent: true, mutation: 'forward' });
  assert.deepEqual(outcome, { timeout: true });
  assert.equal(requests.length, 2);
});
