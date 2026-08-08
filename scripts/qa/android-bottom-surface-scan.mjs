#!/usr/bin/env node
/**
 * 실기기(Android WebView) 하단 고정 surface 겹침 실측 스캐너.
 *
 * 목적: "CSS 클래스가 있다"가 아니라 "실제 단말에서 시스템 내비게이션 바 뒤로
 * 깔리는가"를 픽셀로 판정한다. env(safe-area-inset-bottom) 이 실제로 몇 px 로
 * 해석되는지도 함께 기록한다(삼순 지적① 검증).
 *
 * 판정 계약:
 *   navSafeBottom = window.innerHeight - env(safe-area-inset-bottom)
 *   하단 고정 요소의 "인터랙티브 컨텐츠 하단"이 navSafeBottom 을 넘으면 FAIL.
 *   요소 자체(배경)는 nav bar 뒤까지 그려도 되지만(edge-to-edge 의도),
 *   버튼·입력창 등 조작 대상은 넘으면 안 된다.
 *
 * 사용:
 *   node scripts/qa/android-bottom-surface-scan.mjs <cdpPort> <path...>
 */
import WebSocket from 'ws';

const PORT = process.argv[2] || '9333';
const PATHS = process.argv.slice(3);
if (PATHS.length === 0) {
  console.error('usage: node android-bottom-surface-scan.mjs <port> <path...>');
  process.exit(2);
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('https://keubo.fan'));
if (!page) { console.error('FAIL: keubo.fan page target 없음'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const myId = ++id; pending.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
await new Promise((r) => ws.on('open', r));

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};

const SCAN = `(async () => {
  await new Promise(r => setTimeout(r, 1200));
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:-9999px;padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.appendChild(probe);
  const inset = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  probe.remove();
  const vh = window.innerHeight;
  const navSafe = vh - inset;

  // 뷰포트 하단에 실제로 닿는 요소만 수집(위치 기준, 클래스 기준 아님)
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky' && cs.position !== 'absolute') continue;
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    const r = el.getBoundingClientRect();
    if (r.height < 8 || r.width < 40) continue;
    if (Math.abs(r.bottom - vh) > 2) continue; // 뷰포트 하단에 닿는 것만

    // 이 요소 안의 조작 대상(버튼/입력/링크) 중 가장 아래 지점
    let deepest = null;
    for (const c of el.querySelectorAll('button,a,input,textarea,select,[role="button"]')) {
      const cr = c.getBoundingClientRect();
      if (cr.height < 4) continue;
      if (!deepest || cr.bottom > deepest.bottom) {
        deepest = { bottom: cr.bottom, tag: c.tagName.toLowerCase(), label: (c.getAttribute('aria-label') || c.textContent || '').trim().slice(0, 24) };
      }
    }
    out.push({
      cls: (el.className || '').toString().slice(0, 100),
      padBottom: cs.paddingBottom,
      rectBottom: Math.round(r.bottom),
      interactiveBottom: deepest ? Math.round(deepest.bottom) : null,
      interactiveLabel: deepest ? deepest.label : null,
      overlapPx: deepest ? Math.round(deepest.bottom - navSafe) : null,
    });
  }
  return { inset, vh, navSafe, elements: out };
})()`;

let failed = 0;
for (const p of PATHS) {
  await send('Page.navigate', { url: `https://keubo.fan${p}` });
  await new Promise((r) => setTimeout(r, 2500));
  let res;
  try { res = await evalJs(SCAN); } catch (e) { console.log(`\n[${p}] 스캔 실패: ${e.message}`); failed++; continue; }
  console.log(`\n=== ${p} === inset=${res.inset}px vh=${res.vh} navSafe=${res.navSafe}`);
  if (res.elements.length === 0) { console.log('  (뷰포트 하단에 닿는 고정 요소 없음)'); continue; }
  for (const e of res.elements) {
    const verdict = e.overlapPx == null ? 'N/A(조작요소 없음)' : (e.overlapPx > 0 ? `❌ FAIL +${e.overlapPx}px` : '✅ ok');
    if (e.overlapPx != null && e.overlapPx > 0) failed++;
    console.log(`  ${verdict}  pad=${e.padBottom} btm=${e.rectBottom} 조작하단=${e.interactiveBottom} "${e.interactiveLabel ?? ''}"`);
    console.log(`     class: ${e.cls}`);
  }
}
ws.close();
console.log(`\n총 위반 ${failed}건`);
process.exit(failed > 0 ? 1 : 0);
