#!/usr/bin/env node
/**
 * 수정본 실기기 검증 — 배포 CSS 위에 *수정된 globals.css 의 .pb-safe 규칙*을 주입하고
 * 실제 수정 대상 마크업들의 겹침을 픽셀로 잰다.
 *
 * 왜 이렇게 하나: 수정은 아직 배포 전이라 keubo.fan 에는 없다. 그렇다고 CSS 를
 * 손으로 베껴 쓰면 "검증기가 대상을 재구현"하는 false-green 이 된다.
 * 그래서 **globals.css 파일에서 .pb-safe 블록을 그대로 읽어** 주입한다 —
 * 파일이 바뀌면 이 검증도 같이 바뀐다.
 */
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GLOBALS = readFileSync(path.join(ROOT, 'src/styles/globals.css'), 'utf8');

const m = GLOBALS.match(/\.pb-safe\s*\{[^}]*\}/);
if (!m) { console.error('FAIL: globals.css 에서 .pb-safe 규칙을 못 읽음 (fail-close)'); process.exit(2); }
const PB_SAFE_RULE = m[0];
if (!/safe-area-inset-bottom/.test(PB_SAFE_RULE)) {
  console.error('FAIL: .pb-safe 가 safe-area-inset-bottom 을 소비하지 않음'); process.exit(2);
}
console.log('주입할 규칙(파일에서 직접 읽음):', PB_SAFE_RULE.replace(/\s+/g, ' '));

const PORT = process.argv[2] || '9333';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('https://keubo.fan'));
if (!page) { console.error('FAIL: page target 없음'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
ws.on('message', (raw) => { const x = JSON.parse(raw.toString()); if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); } });
const send = (method, params = {}) => new Promise((res) => { const myId = ++id; pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });
await new Promise((r) => ws.on('open', r));
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};

// 실제 수정된 호출부들의 className 조합 (소스에서 그대로 가져옴)
const CASES = [
  { name: 'DM composer (py-3)', cls: 'px-5 py-3 border-t border-border bg-bg-secondary pb-safe', base: '0.75rem', expectBase: 12 },
  { name: '바텀시트 (p-5)', cls: 'p-5 pb-safe', base: null, expectBase: 20 },
  { name: 'ReportSheet 스크롤러 (py-4)', cls: 'px-5 py-4 pb-safe', base: '1rem', expectBase: 16 },
  { name: 'AddGameSheet 스크롤러 (pt-3/pb-4)', cls: 'px-4 pt-3 pb-safe', base: '1rem', expectBase: 16 },
];

const RUN = (rule, cases) => `(() => {
  document.getElementById('__fix_css')?.remove();
  const s = document.createElement('style');
  s.id = '__fix_css';
  s.textContent = ${JSON.stringify('')} + ${JSON.stringify(rule)};
  document.head.appendChild(s);

  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:-9999px;padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.appendChild(probe);
  const inset = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  probe.remove();

  const out = [];
  for (const c of ${JSON.stringify(cases)}) {
    const el = document.createElement('div');
    el.className = c.cls;
    if (c.base) el.style.setProperty('--pb-safe-base', c.base);
    el.style.position = 'fixed'; el.style.left = '-9999px'; el.style.width = '300px';
    document.body.appendChild(el);
    out.push({ name: c.name, padPx: parseFloat(getComputedStyle(el).paddingBottom) || 0, expectBase: c.expectBase });
    el.remove();
  }
  document.getElementById('__fix_css')?.remove();
  return { inset, out };
})()`;

const r = await evalJs(RUN(PB_SAFE_RULE, CASES));
console.log(`\n실기기 env(safe-area-inset-bottom) = ${r.inset}px`);
let bad = 0;
for (const c of r.out) {
  // 계약: padding = 기존 여백(expectBase) + inset. 겹침 0 이면서 기존 여백도 보존.
  const want = c.expectBase + r.inset;
  const ok = Math.abs(c.padPx - want) < 1;
  if (!ok) bad++;
  console.log(`  ${ok ? '✅' : '❌'} ${c.name}: padding=${c.padPx}px (기대 ${c.expectBase}+${r.inset}=${want}px)`);
}

// inset=0 회귀 확인: env 를 0 으로 만든 상태에서 기존 여백이 그대로인가
const ZERO = await evalJs(`(() => {
  document.getElementById('__fix_css')?.remove();
  const s = document.createElement('style');
  s.id = '__fix_css';
  // env 를 0 으로 강제(회귀 확인용) — 규칙 자체는 파일에서 읽은 것을 쓰되 env 만 0 치환
  s.textContent = ${JSON.stringify(PB_SAFE_RULE.replace(/env\(safe-area-inset-bottom,\s*0px\)/, '0px'))};
  document.head.appendChild(s);
  const out = [];
  for (const c of ${JSON.stringify(CASES)}) {
    const el = document.createElement('div');
    el.className = c.cls;
    if (c.base) el.style.setProperty('--pb-safe-base', c.base);
    el.style.position = 'fixed'; el.style.left = '-9999px'; el.style.width = '300px';
    document.body.appendChild(el);
    out.push({ name: c.name, padPx: parseFloat(getComputedStyle(el).paddingBottom) || 0, expectBase: c.expectBase });
    el.remove();
  }
  document.getElementById('__fix_css')?.remove();
  return out;
})()`);
console.log('\ninset=0 (제스처 내비/웹/데스크톱) 회귀 확인 — 기존 여백 보존되어야 함:');
for (const c of ZERO) {
  const ok = Math.abs(c.padPx - c.expectBase) < 1;
  if (!ok) bad++;
  console.log(`  ${ok ? '✅' : '❌'} ${c.name}: padding=${c.padPx}px (기존 ${c.expectBase}px)`);
}

ws.close();
console.log(`\n결과: ${bad === 0 ? 'PASS' : `FAIL (${bad}건)`}`);
process.exit(bad === 0 ? 0 : 1);
