#!/usr/bin/env node
/**
 * Korean IME composition regression test.
 *
 * The focus-entry one-shot align (commits daefaaea + 7f5f70ab + a6cd1bee)
 * must stay stable across the composition lifecycle that iOS Safari +
 * Korean keyboard generates (compositionstart → compositionupdate per jamo
 * → compositionend on syllable). Concerns:
 *  - composition events should NOT trigger any new scrollTo while focused
 *  - layout should stay pinned (no jump as IME accessory bar height changes
 *    on some iOS versions during composition)
 *  - blur during mid-composition should still cleanly cancel pending
 *    focus-entry timers (verifying the new focusAlignTimersRef cancellation
 *    from a6cd1bee)
 *
 * Strategy: Playwright Webkit + simulated layout viewport shrink. Dispatch
 * the actual composition* events the way iOS WebKit does. This validates
 * the layout/scroll invariants without needing a real Korean keyboard
 * (Appium hardware-keyboard switching is brittle across BS device profiles).
 */

import { webkit } from 'playwright';
import { mkdir } from 'node:fs/promises';

const PREVIEW_BASE = process.env.PREVIEW_BASE
  || 'https://kbo-everyday-6ikhjodoa-hwinsides-projects.vercel.app';
const BYPASS = 'x-vercel-protection-bypass=Zl0mZTENCgq68o5B0VGbcVocVx8NTiRy&x-vercel-set-bypass-cookie=true&chatQaKeyboard=1';
const GAME_IDS = ['20260505OBLG0'];
const OUT_DIR = '/tmp/qa-ime-compose';
await mkdir(OUT_DIR, { recursive: true });

const VP_BASELINE = { width: 390, height: 664 };
const VP_KBD_OPEN = { width: 390, height: 373 };

const ALL = [];
const assert = (game, name, cond, detail) => {
  ALL.push({ game, name, pass: !!cond, detail });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// Compose "안녕" (annyeong) jamo by jamo as iOS Korean IME would emit
const COMPOSITION_STEPS = [
  { type: 'compositionstart', data: '' },
  { type: 'compositionupdate', data: 'ㅇ' },
  { type: 'compositionupdate', data: '아' },
  { type: 'compositionupdate', data: '안' },
  { type: 'compositionend', data: '안' },
  { type: 'compositionstart', data: '' },
  { type: 'compositionupdate', data: 'ㄴ' },
  { type: 'compositionupdate', data: '녀' },
  { type: 'compositionupdate', data: '녕' },
  { type: 'compositionend', data: '녕' },
];

async function probe(page, gameId) {
  console.log(`\n=== ${gameId} (Korean IME composition) ===`);
  const url = `${PREVIEW_BASE}/games/${gameId}?${BYPASS}`;
  await page.setViewportSize(VP_BASELINE);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('[data-composer="game-chat"]', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-chat-msg]').length > 0, { timeout: 15000 });
  await page.waitForTimeout(1500);

  await page.evaluate(() => {
    window.__scrollLog = [];
    const orig = window.scrollTo;
    window.scrollTo = function (...args) {
      window.__scrollLog.push({ t: Date.now(), args, kbd: document.body.classList.contains('kbd-open') });
      return orig.apply(window, args);
    };
  });

  await page.click('[data-composer="game-chat"] textarea');
  await page.setViewportSize(VP_KBD_OPEN);
  await page.waitForTimeout(900);

  const beforeCompose = await page.evaluate(() => {
    const c = document.querySelector('[data-composer="game-chat"]');
    return { scrollY: window.scrollY, composerTop: Math.round(c.getBoundingClientRect().top) };
  });
  console.log('BEFORE compose:', JSON.stringify(beforeCompose));
  await page.screenshot({ path: `${OUT_DIR}/${gameId}-1-focus.png` });

  const composeStartMarker = Date.now();
  await page.evaluate((marker) => { window.__composeMarker = marker; }, composeStartMarker);

  for (const step of COMPOSITION_STEPS) {
    await page.evaluate((s) => {
      const ta = document.querySelector('[data-composer="game-chat"] textarea');
      if (!ta) return;
      const evt = new CompositionEvent(s.type, { data: s.data, bubbles: true });
      ta.dispatchEvent(evt);
      // iOS also fires `input` with isComposing=true during compose
      if (s.type === 'compositionupdate' || s.type === 'compositionend') {
        ta.value = (ta.value || '') + (s.type === 'compositionend' ? s.data : '');
        const ie = new InputEvent('input', { data: s.data, isComposing: s.type !== 'compositionend', bubbles: true });
        ta.dispatchEvent(ie);
      }
    }, step);
    await page.waitForTimeout(80);  // simulate typing rhythm (~80ms/jamo)
  }

  await page.waitForTimeout(400);

  const afterCompose = await page.evaluate(() => {
    const c = document.querySelector('[data-composer="game-chat"]');
    const ta = document.querySelector('[data-composer="game-chat"] textarea');
    return {
      scrollY: window.scrollY,
      composerTop: Math.round(c.getBoundingClientRect().top),
      taValue: ta?.value || '',
      kbdStillOpen: document.body.classList.contains('kbd-open'),
      scrollLog: window.__scrollLog || [],
      composeMarker: window.__composeMarker,
    };
  });
  console.log('AFTER compose:', JSON.stringify(afterCompose));
  await page.screenshot({ path: `${OUT_DIR}/${gameId}-2-after-compose.png` });

  assert(gameId, 'kbd-open still set during/after composition', afterCompose.kbdStillOpen);
  assert(gameId, 'composer position stable through composition',
    Math.abs(afterCompose.composerTop - beforeCompose.composerTop) <= 4,
    `before=${beforeCompose.composerTop} after=${afterCompose.composerTop}`);
  assert(gameId, 'scrollY stable through composition (no jump)',
    Math.abs(afterCompose.scrollY - beforeCompose.scrollY) <= 4,
    `before=${beforeCompose.scrollY} after=${afterCompose.scrollY}`);
  const postComposeScrolls = afterCompose.scrollLog.filter(l => l.kbd && l.t > composeStartMarker);
  assert(gameId, 'no scrollTo triggered by composition events',
    postComposeScrolls.length === 0,
    `post-compose kbd-scrolls=${postComposeScrolls.length}`);

  // Mid-composition blur (rare but real: user taps elsewhere mid-syllable)
  await page.evaluate(() => {
    const ta = document.querySelector('[data-composer="game-chat"] textarea');
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ', bubbles: true }));
  });
  const beforeBlurDuringCompose = Date.now();
  await page.evaluate((m) => { window.__blurMarker = m; }, beforeBlurDuringCompose);
  await page.evaluate(() => {
    document.querySelector('[data-composer="game-chat"] textarea')?.blur();
  });
  await page.setViewportSize(VP_BASELINE);
  await page.waitForTimeout(900);

  const afterMidComposeBlur = await page.evaluate(() => {
    const c = document.querySelector('[data-composer="game-chat"]');
    const tabbar = document.querySelector('[data-global-tabbar]');
    return {
      scrollY: window.scrollY,
      composer: { top: Math.round(c.getBoundingClientRect().top), bottom: Math.round(c.getBoundingClientRect().bottom) },
      tabbar: tabbar ? { top: Math.round(tabbar.getBoundingClientRect().top) } : null,
      kbd: document.body.classList.contains('kbd-open'),
      scrollLog: window.__scrollLog || [],
      blurMarker: window.__blurMarker,
    };
  });
  console.log('AFTER mid-compose blur:', JSON.stringify({ ...afterMidComposeBlur, scrollLog: `[${afterMidComposeBlur.scrollLog.length} entries]` }));
  await page.screenshot({ path: `${OUT_DIR}/${gameId}-3-blur-mid-compose.png` });

  assert(gameId, 'kbd-open removed on mid-compose blur', !afterMidComposeBlur.kbd);
  assert(gameId, 'composer back to TabBar after mid-compose blur',
    afterMidComposeBlur.tabbar != null
      && afterMidComposeBlur.composer.bottom <= afterMidComposeBlur.tabbar.top + 4,
    `composer.bottom=${afterMidComposeBlur.composer.bottom} tabbar.top=${afterMidComposeBlur.tabbar?.top}`);
  // After blur, focus→idle align fires (scheduleChatFocusAlign) and that IS allowed.
  // We just verify no runaway after blur completes.
  await page.waitForTimeout(800);
  const afterSettle = await page.evaluate(() => ({
    scrollY: window.scrollY,
    scrollLog: window.__scrollLog || [],
  }));
  // Count scrollTo calls in last 600ms (after blur+settle window)
  const cutoff = Date.now() - 600;
  const recentScrolls = afterSettle.scrollLog.filter(l => l.t > cutoff);
  assert(gameId, 'no runaway scrollTo after blur settle',
    recentScrolls.length === 0,
    `recent (last 600ms) scrollTo count=${recentScrolls.length}`);
}

const browser = await webkit.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
try {
  for (const id of GAME_IDS) await probe(page, id);
} finally {
  await browser.close();
}

const pass = ALL.filter(a => a.pass).length;
const total = ALL.length;
console.log(`\n=== IME COMPOSE VERDICT: ${pass}/${total} ===`);
if (pass < total) {
  for (const a of ALL.filter(a => !a.pass)) {
    console.log(`  ✗ [${a.game}] ${a.name} — ${a.detail}`);
  }
  process.exit(1);
}
