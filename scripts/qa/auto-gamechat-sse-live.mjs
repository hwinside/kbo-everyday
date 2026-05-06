#!/usr/bin/env node
/**
 * SSE live-message regression test for feature/gamechat-flex-restructure.
 *
 * Why: focus-entry one-shot align (commits daefaaea + 7f5f70ab + a6cd1bee)
 * needs to be stable when new chat messages arrive *during* the focus session
 * (real users get continuous SSE delivery while typing). The messages.length
 * effect path is guarded by `keyboardFocusedRef.current` — no scrollTo on new
 * arrival during focus — but the screen layout shifts because new messages
 * push older ones down. We need to verify:
 *   - scrollY does NOT change when new messages arrive during focus (no jump)
 *   - composer stays at fixed bottom:0 (no overflow / black gap)
 *   - the 5 most-recent messages remain contiguous above the composer
 *   - blur after live messages → focus→idle align restores correct view
 *
 * Strategy: Playwright Webkit, simulate iOS layout-viewport shrink, then
 * inject mock messages directly into the React message list via window
 * dispatch (chat hook doesn't expose imperative inject, so we mutate the
 * DOM with synthetic [data-chat-msg] nodes the way a new SSE delivery would
 * cause React to render). This validates the *layout/scroll* invariants —
 * which is what the regression is about — without needing two Supabase users.
 */

import { webkit } from 'playwright';
import { mkdir } from 'node:fs/promises';

const PREVIEW_BASE = process.env.PREVIEW_BASE
  || 'https://kbo-everyday-6ikhjodoa-hwinsides-projects.vercel.app';
const BYPASS = 'x-vercel-protection-bypass=Zl0mZTENCgq68o5B0VGbcVocVx8NTiRy&x-vercel-set-bypass-cookie=true&chatQaKeyboard=1';
const GAME_IDS = ['20260505OBLG0'];
const OUT_DIR = '/tmp/qa-sse-live';
await mkdir(OUT_DIR, { recursive: true });

const VP_BASELINE = { width: 390, height: 664 };
const VP_KBD_OPEN = { width: 390, height: 373 };

const ALL = [];
const assert = (game, name, cond, detail) => {
  ALL.push({ game, name, pass: !!cond, detail });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function probe(page, gameId) {
  console.log(`\n=== ${gameId} ===`);
  const url = `${PREVIEW_BASE}/games/${gameId}?${BYPASS}`;
  await page.setViewportSize(VP_BASELINE);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('[data-composer="game-chat"]', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-chat-msg]').length > 0, { timeout: 15000 });
  await page.waitForTimeout(1500);

  // Install scrollTo monkey-patch
  await page.evaluate(() => {
    window.__scrollLog = [];
    const orig = window.scrollTo;
    window.scrollTo = function (...args) {
      window.__scrollLog.push({ t: Date.now(), args, kbd: document.body.classList.contains('kbd-open') });
      return orig.apply(window, args);
    };
  });

  // Focus textarea (enter focus mode)
  await page.click('[data-composer="game-chat"] textarea');
  await page.setViewportSize(VP_KBD_OPEN);
  await page.waitForTimeout(900);  // let focus-entry align fire

  const beforeInject = await page.evaluate(() => {
    const c = document.querySelector('[data-composer="game-chat"]');
    const cb = c.getBoundingClientRect();
    const msgs = [...document.querySelectorAll('[data-chat-msg]')];
    return {
      scrollY: window.scrollY,
      composer: { top: Math.round(cb.top), bottom: Math.round(cb.bottom) },
      msgCount: msgs.length,
      first5: msgs.slice(0, 5).map(m => ({ top: Math.round(m.getBoundingClientRect().top) })),
    };
  });
  console.log('BEFORE inject:', JSON.stringify(beforeInject));
  await page.screenshot({ path: `${OUT_DIR}/${gameId}-1-focus-before.png` });

  // Mark a high-water timestamp so post-inject scrollTo calls can be isolated
  // from the focus-entry one-shot align that fired earlier.
  const injectMarker = Date.now();
  await page.evaluate((marker) => { window.__injectMarker = marker; }, injectMarker);

  // Simulate 5 new SSE messages arriving by inserting synthetic message nodes
  // at the TOP of the rendered list (newest-first ordering matches real React
  // render of useChat's reversed array on new arrivals).
  const injectResult = await page.evaluate(() => {
    const list = document.querySelector('[data-chat-msg]')?.parentElement;
    if (!list) return { error: 'no list' };
    const before = window.scrollY;
    const newNodes = [];
    for (let i = 0; i < 5; i++) {
      const node = document.createElement('div');
      node.setAttribute('data-chat-msg', '');
      node.style.cssText = 'height: 30px; margin: 1px 0; background: #2a2; color: white; padding: 4px;';
      node.textContent = `[SSE-LIVE-${i}] live new message`;
      list.insertBefore(node, list.firstChild);
      newNodes.push(node);
    }
    return { before, after: window.scrollY, newNodeCount: newNodes.length };
  });
  console.log('INJECT:', JSON.stringify(injectResult));
  await page.waitForTimeout(800);  // wait for any reactive rerender + async aligns

  const afterInject = await page.evaluate(() => {
    const c = document.querySelector('[data-composer="game-chat"]');
    const cb = c.getBoundingClientRect();
    const msgs = [...document.querySelectorAll('[data-chat-msg]')];
    return {
      scrollY: window.scrollY,
      composer: { top: Math.round(cb.top), bottom: Math.round(cb.bottom) },
      msgCount: msgs.length,
      first5: msgs.slice(0, 5).map(m => ({ top: Math.round(m.getBoundingClientRect().top) })),
      kbdStillOpen: document.body.classList.contains('kbd-open'),
      scrollLog: window.__scrollLog || [],
    };
  });
  console.log('AFTER inject + 800ms:', JSON.stringify(afterInject));
  await page.screenshot({ path: `${OUT_DIR}/${gameId}-2-focus-after-inject.png` });

  // === Assertions ===
  assert(gameId, 'kbd-open still set after live messages', afterInject.kbdStillOpen);
  assert(gameId, 'composer position unchanged after live messages',
    Math.abs(afterInject.composer.top - beforeInject.composer.top) <= 4,
    `before=${beforeInject.composer.top} after=${afterInject.composer.top}`);
  const postInjectScrolls = afterInject.scrollLog.filter(l => l.kbd && l.t > injectMarker);
  assert(gameId, 'no scrollTo called by live message arrival in focus',
    postInjectScrolls.length === 0,
    `post-inject kbd-scrolls=${postInjectScrolls.length} (total kbd=${afterInject.scrollLog.filter(l => l.kbd).length}, pre-inject expected ≥1 for focus-entry align)`);
  // The 5 SSE-LIVE messages were inserted; depending on React reconciliation
  // they may or may not survive a re-render. The key check is layout stability.
  assert(gameId, 'msgCount increased (5 new messages)',
    afterInject.msgCount >= beforeInject.msgCount + 5,
    `before=${beforeInject.msgCount} after=${afterInject.msgCount}`);
  assert(gameId, 'no document jump (scrollY shift ≤ 4px)',
    Math.abs(afterInject.scrollY - beforeInject.scrollY) <= 4,
    `before=${beforeInject.scrollY} after=${afterInject.scrollY}`);

  // Blur and verify focus→idle align restores 5-slice view
  await page.evaluate(() => document.querySelector('[data-composer="game-chat"] textarea')?.blur());
  await page.setViewportSize(VP_BASELINE);
  await page.waitForTimeout(900);
  const afterBlur = await page.evaluate(() => {
    const c = document.querySelector('[data-composer="game-chat"]');
    const cb = c.getBoundingClientRect();
    const tabbar = document.querySelector('[data-global-tabbar]');
    return {
      scrollY: window.scrollY,
      composer: { top: Math.round(cb.top), bottom: Math.round(cb.bottom) },
      tabbar: tabbar ? { top: Math.round(tabbar.getBoundingClientRect().top) } : null,
      kbd: document.body.classList.contains('kbd-open'),
    };
  });
  console.log('AFTER blur:', JSON.stringify(afterBlur));
  await page.screenshot({ path: `${OUT_DIR}/${gameId}-3-blur.png` });

  assert(gameId, 'kbd-open removed on blur', !afterBlur.kbd);
  assert(gameId, 'composer back to TabBar position after blur',
    afterBlur.tabbar != null && afterBlur.composer.bottom <= afterBlur.tabbar.top + 4,
    `composer.bottom=${afterBlur.composer.bottom} tabbar.top=${afterBlur.tabbar?.top}`);
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
console.log(`\n=== SSE LIVE VERDICT: ${pass}/${total} ===`);
if (pass < total) {
  for (const a of ALL.filter(a => !a.pass)) {
    console.log(`  ✗ [${a.game}] ${a.name} — ${a.detail}`);
  }
  process.exit(1);
}
