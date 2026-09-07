/** Reviewer: real Server-Timing -> same-document reader in Chromium and WebKit.
 * Loopback only; no accounts/storage/auth calls. Does not emulate iOS lifecycle. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(resolve(process.argv[2] || root, 'package.json'));
const { build } = require('esbuild');
const { chromium, webkit } = require('playwright');
const results = [];

async function main() {
  const bundle = await build({ entryPoints: [resolve(root, 'src/lib/auth/boot-trace-schema.ts')], bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'BootTrace' });
  const issued = new Map();
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Cache-Control', 'private, no-store');
    if (request.url !== '/unlinked') {
      const trace = randomUUID();
      issued.set(request.url, trace);
      response.setHeader('Server-Timing', `other;dur=1, kbo-auth-boot;desc="${trace}"`);
    }
    response.end(`<!doctype html><script>${bundle.outputFiles[0].text}</script><script>window.earlyTrace=BootTrace.readBootTraceId(performance);</script><body>fixture</body>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
      const browser = await launcher.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(`${base}/${engine}-first`);
        const first = await page.evaluate(() => ({ early: window.earlyTrace, afterLoad: BootTrace.readBootTraceId(performance) }));
        assert.equal(first.early, issued.get(`/${engine}-first`), 'inline/SDK initialization can read document response timing');
        assert.equal(first.afterLoad, first.early);
        await page.reload();
        const second = await page.evaluate(() => BootTrace.readBootTraceId(performance));
        assert.equal(second, issued.get(`/${engine}-first`));
        assert.notEqual(second, first.early, 'hard navigation must not reuse a cached trace ID');
        await page.goto(`${base}/unlinked`);
        assert.equal(await page.evaluate(() => BootTrace.readBootTraceId(performance)), null);
        results.push({ engine, inlineHeaderRoundTrip: true, uniqueReloadId: true, missingHeaderUnlinked: true });
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
  await writeFile(resolve(root, 'auth-boot-header-report.json'), JSON.stringify({ scope: 'loopback browser header transport only; not iOS WKWebView/production', results }, null, 2) + '\n');
  console.log('PASS Server-Timing transport: Chromium + WebKit, early read, unique reload, absent header');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
