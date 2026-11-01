const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const { JSDOM, VirtualConsole } = require('jsdom');

test('optional lazy rejection is reported but preserves the home shell; success still renders', async () => {
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
        await act(async () => reject(new Error('Failed to load chunk /_next/static/chunks/example.js')));
        const settled = document.body.textContent;
        const reports = window.reports.slice();
        await act(async () => root.unmount());
        return {pending, settled, reports};
      };
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{name:'telemetry-spy', setup(b) {
      b.onResolve({filter:/^@\/lib\/client-error-report$/}, () => ({path:'report',namespace:'spy'}));
      b.onLoad({filter:/.*/,namespace:'spy'}, () => ({contents:'export const reportClientError = input => window.reports.push(input);',loader:'js'}));
    }}],
  });
  const dom = new JSDOM('<div id="root"></div>', {url:'https://keubo.test/', runScripts:'outside-only', virtualConsole:new VirtualConsole()});
  try {
    dom.window.MessageChannel = class {
      constructor() {
        this.port1 = {};
        this.port2 = {postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0)};
      }
    };
    dom.window.eval(result.outputFiles[0].text);
    const {pending, settled, reports} = await dom.window.run();
    assert.match(pending, /pending/);
    assert.match(settled, /live score/);
    assert.match(settled, /loaded section/);
    assert.match(settled, /이 영역을 불러오지 못했어요/);
    assert.doesNotMatch(settled, /pending/);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].source, 'error-boundary');
    assert.match(reports[0].message, /Failed to load chunk/);
  } finally { dom.window.close(); }
});
