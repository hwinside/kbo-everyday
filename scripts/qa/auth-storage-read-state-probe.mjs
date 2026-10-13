/**
 * Read-only investigation runner: synthetic storage on loopback only.
 * Reviewer executes; no production account, auth endpoint, or iOS device used.
 * Usage: node scripts/qa/auth-storage-read-state-probe.mjs [dependency-root]
 * Observe detached-document behavior, do not equate a match with incident cause.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(resolve(process.argv[2] || root, 'package.json'));
const { build } = require('esbuild');
const { chromium, webkit } = require('playwright');
const report = {
  sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  scope: 'synthetic same-origin document lifecycle; not native WKWebView or incident proof',
  cases: [],
};
const expectedPresent = { auth: 2, otherAuth: false, ga: true, marker: true };
const expectedAbsent = { auth: 0, otherAuth: false, ga: false, marker: false };
const reportedSignature = { auth: 0, otherAuth: false, ga: false, marker: null };

async function main() {
  const source = await readFile(resolve(root, 'src/lib/auth/session-diagnostics.ts'), 'utf8');
  assert.ok(source.includes('createAuthSessionDiagnostics'), 'uses repository observer');
  const bundle = await build({
    entryPoints: [resolve(root, 'src/lib/auth/session-diagnostics.ts')],
    nodePaths: [resolve(process.argv[2] || root, 'node_modules')],
    bundle: true, write: false, platform: 'browser', format: 'iife',
    globalName: 'StorageProbeModule', logLevel: 'silent',
  });
  const js = bundle.outputFiles[0].text;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/observer.js') {
      res.setHeader('Content-Type', 'application/javascript'); res.end(js); return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8"><script src="/observer.js"></script><body>synthetic storage probe</body>');
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
      let browser;
      try {
        browser = await browserType.launch({ headless: true });
        const context = await browser.newContext();
        await context.route('**/*', route => {
          if (new URL(route.request().url()).origin === origin) return route.continue();
          return route.abort();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        await page.goto(origin, { waitUntil: 'load' });
        const observed = await page.evaluate(async origin => {
          const seed = target => {
            target.document.cookie = 'sb-probe-auth-token.0=synthetic_a; Path=/';
            target.document.cookie = 'sb-probe-auth-token.1=synthetic_b; Path=/';
            target.document.cookie = '_ga=synthetic_ga; Path=/';
            target.localStorage.setItem('kbo-auth-uid', 'synthetic_marker');
          };
          const observerFor = target => {
            const observer = target.StorageProbeModule.createAuthSessionDiagnostics();
            observer.observeFetch('https://probe.supabase.co', async () => new Response('{}'));
            return observer;
          };
          seed(window);
          const liveObserver = observerFor(window);
          const baseline = liveObserver.capture();
          // Positive control: real removal of synthetic keys, no getter overrides.
          for (const name of ['sb-probe-auth-token.0', 'sb-probe-auth-token.1', '_ga']) {
            document.cookie = `${name}=; Max-Age=0; Path=/`;
          }
          localStorage.removeItem('kbo-auth-uid');
          const actualRemoval = liveObserver.capture();
          seed(window);
          const frame = document.createElement('iframe');
          frame.src = `${origin}/child`;
          await new Promise((resolveFrame, rejectFrame) => {
            frame.onload = resolveFrame;
            frame.onerror = () => rejectFrame(new Error('local frame failed'));
            document.body.append(frame);
          });
          const child = frame.contentWindow;
          const detachedObserver = observerFor(child);
          const beforeDetach = detachedObserver.capture();
          // No storage API writes below: only remove the browsing context.
          frame.remove();
          const afterDetach = detachedObserver.capture();
          let detachedMarkerRead = 'unknown';
          try { detachedMarkerRead = child.localStorage.getItem('kbo-auth-uid') === null ? 'absent' : 'present'; }
          catch (error) { detachedMarkerRead = `exception:${error.name}`; }
          const liveBackingAfterDetach = liveObserver.capture();
          await new Promise(resolveTick => setTimeout(resolveTick, 100));
          const afterDetachLater = detachedObserver.capture();
          const liveBackingLater = liveObserver.capture();
          return { baseline, actualRemoval, beforeDetach, afterDetach, detachedMarkerRead,
            liveBackingAfterDetach, afterDetachLater, liveBackingLater };
        }, origin);
        assert.deepEqual(observed.baseline, expectedPresent, `${engine}: seed`);
        assert.deepEqual(observed.actualRemoval, expectedAbsent, `${engine}: actual removal must mean marker=false`);
        assert.deepEqual(observed.beforeDetach, expectedPresent, `${engine}: child can read before detach`);
        assert.deepEqual(observed.liveBackingAfterDetach, expectedPresent, `${engine}: live origin storage survived detach`);
        assert.deepEqual(observed.liveBackingLater, expectedPresent, `${engine}: live origin storage still present`);
        report.cases.push({ engine, controlChecks: 'passed', ...observed,
          detachedMatchesReportedSignature: JSON.stringify(observed.afterDetach) === JSON.stringify(reportedSignature),
          interpretation: 'detached match, if any, is an alternative explanation only; native incident not reproduced' });
      } catch (error) {
        report.cases.push({ engine, controlChecks: 'failed-or-unavailable', errorName: error.name,
          message: String(error.message).slice(0, 700) });
        process.exitCode = 1;
      } finally { if (browser) await browser.close(); }
    }
  } finally { await new Promise(resolveClose => server.close(resolveClose)); }
  await writeFile(resolve(root, 'auth-storage-read-state-report.json'), JSON.stringify(report, null, 2));
  for (const entry of report.cases) console.log(JSON.stringify(entry));
}

const deadline = setTimeout(() => { console.error('probe timeout'); process.exit(1); }, 90000);
main().catch(error => { console.error(error.name + ': ' + String(error.message).slice(0, 700)); process.exitCode = 1; })
  .finally(() => clearTimeout(deadline));
