#!/usr/bin/env node
/**
 * DM composer nav-bar 겹침 — 실기기 재현 + 수정 검증.
 *
 * 로그인 없이도 결함 자체를 재현하려고, *배포된 production CSS 위에*
 * DM composer 와 동일한 className 을 가진 요소를 주입해 실측한다.
 * (production 에는 .pb-safe 정의가 없으므로 그 no-op 상태가 그대로 재현된다)
 *
 * 3단계로 잰다:
 *   [1] 현재 배포 상태          → 겹침 발생해야 정상(= 결함 재현 성공)
 *   [2] 후보 수정 CSS 주입 후   → 겹침 0이어야 통과
 *   [3] 결함주입(env 무시 규칙) → 다시 겹쳐야 함(= 검증기가 살아있음을 증명)
 */
import WebSocket from 'ws';

const PORT = process.argv[2] || '9333';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('https://keubo.fan'));
if (!page) { console.error('FAIL: page target 없음'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const myId = ++id; pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });
await new Promise((r) => ws.on('open', r));
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
};

// DM composer 원문 구조 (src/app/(main)/messages/[conversationId]/page.tsx)
const MOUNT = `(() => {
  document.getElementById('__probe_composer')?.remove();
  document.getElementById('__probe_css')?.remove();
  const wrap = document.createElement('div');
  wrap.id = '__probe_composer';
  wrap.className = 'fixed bottom-0 left-0 right-0 z-[99999]';
  wrap.innerHTML = '<div class="px-5 py-3 border-t border-border bg-bg-secondary pb-safe"><div class="flex items-end gap-2"><textarea rows="1" style="flex:1"></textarea><button id="__probe_send" style="width:40px;height:40px;border-radius:9999px;background:#c00">S</button></div></div>';
  document.body.appendChild(wrap);
  return true;
})()`;

const MEASURE = `(() => {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:-9999px;padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.appendChild(probe);
  const inset = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  probe.remove();
  const vh = window.innerHeight;
  const navSafe = vh - inset;
  const btn = document.getElementById('__probe_send').getBoundingClientRect();
  const row = document.querySelector('#__probe_composer > div');
  return {
    inset, vh, navSafe,
    padBottom: getComputedStyle(row).paddingBottom,
    sendBottom: Math.round(btn.bottom),
    overlapPx: Math.round(btn.bottom - navSafe),
  };
})()`;

const injectCss = (css, marker) => `(() => {
  document.getElementById('__probe_css')?.remove();
  const s = document.createElement('style');
  s.id = '__probe_css';
  s.textContent = ${JSON.stringify(css)};
  document.head.appendChild(s);
  return ${JSON.stringify(marker)};
})()`;

const FIX_CSS = `.pb-safe{padding-bottom:calc(var(--pb-safe-base, 1.25rem) + env(safe-area-inset-bottom, 0px))}`;
// 결함주입: env 를 못 읽는(=수정 이전과 동일한) 상태로 되돌린다
const MUTANT_CSS = `.pb-safe{padding-bottom:calc(var(--pb-safe-base, 1.25rem) + 0px)}`;

await evalJs(MOUNT);
const before = await evalJs(MEASURE);
console.log('[1] 현재 배포 상태 (.pb-safe 미정의):', JSON.stringify(before));

await evalJs(injectCss(FIX_CSS, 'fix'));
const after = await evalJs(MEASURE);
console.log('[2] 수정 CSS 주입 후            :', JSON.stringify(after));

await evalJs(injectCss(MUTANT_CSS, 'mutant'));
const mutant = await evalJs(MEASURE);
console.log('[3] 결함주입(env 제거)          :', JSON.stringify(mutant));

await evalJs(`(() => { document.getElementById('__probe_composer')?.remove(); document.getElementById('__probe_css')?.remove(); return true; })()`);
ws.close();

const ok =
  before.overlapPx > 0 &&   // 결함이 실제로 재현됨
  after.overlapPx <= 0 &&   // 수정이 실제로 닫음
  mutant.overlapPx > 0;     // 검증기가 결함을 다시 잡아냄(false-green 아님)

console.log('\n판정:',
  `재현 ${before.overlapPx > 0 ? 'OK' : 'FAIL'} /`,
  `수정 ${after.overlapPx <= 0 ? 'OK' : 'FAIL'} /`,
  `mutation RED ${mutant.overlapPx > 0 ? 'OK' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
