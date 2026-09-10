// Offline component regression: no credentials, network or database writes.
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = await mkdtemp(resolve('.slides-qa-'));
try {
  const result = await build({ stdin: { contents: `
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import Slides from './src/components/game/GameReviewTeamSlides';
const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
let reduced = false, listener;
window.matchMedia = () => ({ get matches() { return reduced; }, addEventListener: (_, cb) => listener = cb, removeEventListener() {} });
globalThis.IntersectionObserver = class { constructor(cb) { this.cb=cb; } observe() { this.cb([{ isIntersecting:true }]); } disconnect() {} };
let resizeObservers=0;
globalThis.ResizeObserver = class { constructor(){ resizeObservers++; } observe() {} disconnect() {} };
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 200 });
HTMLElement.prototype.scrollTo = function({left}) { this.scrollLeft=left; this.dispatchEvent(new window.Event('scroll', {bubbles:true})); };
const timers = new Map(); let timerId=0;
window.setInterval = cb => { timers.set(++timerId, cb); return timerId; };
window.clearInterval = id => timers.delete(id);
const rows = Array.from({length:25}, (_, i) => ({id:i+1,team_id:1,content:'row'+(i+1)}));
const calls=[];
const request = async path => { calls.push(path); return { viewerId:null, feed: { rows:path.includes('cursor=') ? [{id:26,team_id:1,content:'row26'}] : rows, best:[rows[0]], next:path.includes('cursor=')?null:'ranked-cursor' } }; };
const renderCard = (row, best) => <article><button>{row.content}</button>{best && <span>BEST</span>}</article>;
const root = createRoot(document.getElementById('app'));
const paint = async (props={}) => act(async () => { root.render(<Slides gameId="game" teamId={1} viewerId={null} request={request} renderCard={renderCard} paused={false} {...props}/>); });
await paint();
assert.equal(calls.length,1); assert.match(calls[0],/team=1/);
assert.equal(document.querySelectorAll('article').length,25);
assert.equal(document.querySelectorAll('[inert]').length,24);
assert.equal(document.querySelectorAll('article span').length,1);
assert.equal(timers.size,1);
await act(async()=>{ [...timers.values()][0](); });
assert.ok(document.body.textContent.includes('2 / 25'));
assert.equal(resizeObservers,1,'slide index must not reconnect ResizeObserver');
const click = async label => act(async()=>document.querySelector('[aria-label="'+label+'"]').click());
await click('자동 넘김 정지'); assert.equal(timers.size,0);
await click('자동 넘김 시작'); assert.equal(timers.size,1);
await paint({paused:true}); assert.equal(timers.size,0);
await paint(); assert.equal(timers.size,1);
await act(async()=>{ reduced=true; listener(); }); assert.equal(timers.size,0);
await act(async()=>{ const rail=document.querySelector('.snap-x'); rail.scrollTo({left:23*200}); });
assert.equal(calls.length,2); assert.match(calls[1],/team=1.*cursor=ranked-cursor/);
assert.equal(document.querySelectorAll('article').length,26);
await act(async()=>root.unmount()); assert.equal(timers.size,0);
const second = createRoot(document.getElementById('app'));
await act(async()=>second.render(<Slides gameId="game" teamId={1} viewerId="new-user" request={request} renderCard={renderCard} paused={false}/>));
assert.equal(document.querySelectorAll('article').length,0); assert.match(document.body.textContent,/불러오지 못했어요/);
await act(async()=>second.unmount());
const third = createRoot(document.getElementById('app'));
const seededPage = { rows:rows.slice(0,3), best:[], next:null };
const callCount = calls.length;
await act(async()=>third.render(<Slides gameId="game" teamId={1} viewerId={null} request={request} renderCard={renderCard} paused={false} initialPage={seededPage}/>));
assert.equal(calls.length,callCount,'complete main feed must avoid duplicate team request');
await click('다음 한 줄');
assert.ok(document.body.textContent.includes('2 / 3'));
const patchedCard = row => <article><button>{row.id===2?'liked row2':row.content}</button></article>;
await act(async()=>third.render(<Slides gameId="game" teamId={1} viewerId={null} request={request} renderCard={patchedCard} paused={false} initialPage={seededPage}/>));
assert.ok(document.body.textContent.includes('liked row2'));
assert.ok(document.body.textContent.includes('2 / 3'),'parent like patch preserves current slide');
assert.equal(calls.length,callCount,'parent rerender must not refetch');
await act(async()=>third.unmount());
console.log('team slides offline regression PASS: ranked paging, BEST label, timer pause/resume, modal, reduced motion, cleanup, viewer isolation');
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
    plugins: [{ name: 'presentation-stubs', setup(b) {
      b.onResolve({ filter: /GameReviewIdentity$/ }, () => ({ path: 'identity', namespace: 'stub' }));
      b.onResolve({ filter: /constants\/teams$/ }, () => ({ path: 'teams', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: args.path === 'identity'
        ? 'export const ReviewTeamIdentity=()=>null; export const reviewTeamStyle=()=>({});'
        : 'export const getTeamById=()=>({shortName:"팀"});', loader: 'js' }));
    } }] });
  const entry = join(dir, 'test.mjs'); await writeFile(entry, result.outputFiles[0].text);
  const run = spawnSync(process.execPath, [entry], { stdio:'inherit' });
  process.exitCode = run.status ?? 1;
} finally { await rm(dir, {recursive:true,force:true}); }
