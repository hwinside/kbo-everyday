#!/usr/bin/env node
/**
 * 실기기(Android WebView) safe-area-inset 실측 프로브.
 *
 * 삼순 지적①: "WebView의 env(safe-area-inset-*)는 0px이라 CSS만으로는 안 닫힌다"
 * → 추정하지 말고 *실제 단말의 WebView*에서 계산값을 읽어 확정한다.
 *
 * 사용: adb forward 로 열어둔 CDP 포트를 넘긴다.
 *   node scripts/qa/android-inset-probe.mjs 9333
 */
import WebSocket from 'ws';

const PORT = process.argv[2] || '9333';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('https://keubo.fan'));
if (!page) {
  console.error('FAIL: keubo.fan page target을 찾지 못함');
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

await new Promise((res) => ws.on('open', res));

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

const probe = `(() => {
  const cs = getComputedStyle(document.documentElement);
  const probeEl = document.createElement('div');
  probeEl.style.cssText = 'position:fixed;left:-9999px;padding-bottom:env(safe-area-inset-bottom,0px);padding-top:env(safe-area-inset-top,0px)';
  document.body.appendChild(probeEl);
  const p = getComputedStyle(probeEl);
  const out = {
    envBottom: p.paddingBottom,
    envTop: p.paddingTop,
    innerH: window.innerHeight,
    outerH: window.outerHeight,
    dpr: window.devicePixelRatio,
    vvH: window.visualViewport ? window.visualViewport.height : null,
    vvOffTop: window.visualViewport ? window.visualViewport.offsetTop : null,
    screenH: window.screen.height,
    ua: navigator.userAgent.slice(0, 120),
    cssVarBottom: cs.getPropertyValue('--safe-area-inset-bottom') || '(unset)',
  };
  probeEl.remove();
  return out;
})()`;

const r = await evalJs(probe);
console.log('=== 실기기 WebView safe-area 실측 ===');
for (const [k, v] of Object.entries(r)) console.log(`  ${k}: ${v}`);

// 하단 고정 요소 실제 위치 — DM composer 가 있으면 잰다
const composerProbe = `(() => {
  const cands = [...document.querySelectorAll('[class*="pb-safe"], .pb-tab-bar, [class*="fixed"][class*="bottom-0"]')];
  return cands.slice(0, 12).map(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      cls: (el.className || '').toString().slice(0, 90),
      bottom: Math.round(r.bottom),
      height: Math.round(r.height),
      padBottom: cs.paddingBottom,
      position: cs.position,
      innerH: window.innerHeight,
      overflowsBy: Math.round(r.bottom - window.innerHeight),
    };
  });
})()`;
const els = await evalJs(composerProbe);
console.log('\n=== 하단 고정 후보 요소 ===');
console.log(JSON.stringify(els, null, 1));

ws.close();
