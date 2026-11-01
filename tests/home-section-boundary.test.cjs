const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const { readFileSync } = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');

for (const [message, shouldReload] of [
  ['Failed to load chunk /_next/static/chunks/example.js', true],
  ['Cannot read properties of undefined', false],
]) test(`isolates ${message}; guarded reload=${shouldReload}`, async () => {
  const result = await build({
    stdin: { contents: `
      import React, { act, lazy } from 'react';
      import { createRoot } from 'react-dom/client';
      import Boundary from './src/components/home/HomeSectionBoundary';
      window.IS_REACT_ACT_ENVIRONMENT = true;
      window.reports = [];
      window.run = async () => {
        const root = createRoot(document.getElementById('root'));
        let reject;
        const Broken = lazy(() => new Promise((_, r) => { reject = r; }));
        const Good = lazy(() => Promise.resolve({default: () => <p>loaded section</p>}));
        await act(async () => root.render(<main><h1>live score</h1>
          <Boundary fallback={<p>pending</p>}><Broken /></Boundary>
          <Boundary fallback={null}><Good /></Boundary></main>));
        const pending = document.body.textContent;
        await act(async () => reject(new Error(${JSON.stringify(message)})));
        const settled = document.body.textContent;
        await new Promise(r => setTimeout(r, 1600));
        const reloadAt = sessionStorage.getItem('kbo_chunk_reload_at');
        window.dispatchEvent(new Event('focus'));
        const reloadAtAfterFocus = sessionStorage.getItem('kbo_chunk_reload_at');
        const reports = window.reports.slice();
        await act(async () => root.unmount());
        return {pending, settled, reports, reloadAt, reloadAtAfterFocus};
      };
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{name:'telemetry-spy', setup(b) {
      b.onResolve({filter:/^@\/lib\/client-error-report$/}, () => ({path:'report',namespace:'spy'}));
      b.onLoad({filter:/.*/,namespace:'spy'}, () => ({contents: readFileSync('src/lib/client-error-report.ts','utf8').split('export type ClientErrorSource')[0].replace(/import .* from .*;\n/, '') + 'export const reportClientError = input => window.reports.push(input);',loader:'ts'}));
    }}],
  });
  const dom = new JSDOM('<div id="root"></div>', {url:'https://keubo.test/', runScripts:'outside-only', pretendToBeVisual:true, virtualConsole:new VirtualConsole()});
  try {
    dom.window.MessageChannel = class {
      constructor() {
        this.port1 = {};
        this.port2 = {postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0)};
      }
    };
    dom.window.eval(result.outputFiles[0].text);
    const {pending, settled, reports, reloadAt, reloadAtAfterFocus} = await dom.window.run();
    assert.match(pending, /pending/);
    assert.match(settled, /live score/);
    assert.match(settled, /loaded section/);
    assert.doesNotMatch(settled, /이 영역을 불러오지 못했어요/);
    assert.equal(Number(reloadAt) > 0, shouldReload);
    assert.equal(reloadAtAfterFocus, reloadAt);
    assert.doesNotMatch(settled, /pending/);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].source, 'error-boundary');
    assert.equal(reports[0].digest, 'home-section-isolated-v1');
    assert.equal(reports[0].message, message);
  } finally { dom.window.close(); }
});
