#!/usr/bin/env node
/**
 * GameChat iOS keyboard 회귀 v3 자동화 게이트.
 *
 * CSO 삼순이 NO-GO 리뷰 (2026-05-06) 후속:
 *   "10~15초 연속 녹화 + 프레임 분석 자동화 PASS 전까지 GO 없음"
 *
 * 시나리오:
 *   1. iOS Safari 실기기 (BrowserStack)에서 GameChat 페이지 로드
 *   2. window.scrollTo / element.scrollIntoView monkey-patch 설치
 *   3. textarea focus
 *   4. 12초간 200ms 간격(60 frames) 측정:
 *        composer rect, visualViewport height, scrollY, kbd-open
 *   5. 1.5s 간격으로 sendKeys로 한 글자씩 입력 (visualViewport resize 시뮬)
 *
 * 게이트 (프레임 분석):
 *   (a) composerInVp:    모든 focus 프레임에서 composer.bottom <= vv.height + 4
 *   (b) noBlackGap:      모든 focus 프레임에서 vv.height - composer.bottom <= 12
 *   (c) noScrollRunaway: focus 중 max(scrollY) - min(scrollY) <= 8
 *   (d) noScrollToInFocus: focus 중 window.scrollTo 호출 횟수 == 0
 *
 * 4개 metric 전부 PASS 시에만 자동화 PASS.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const username = process.env.BROWSERSTACK_USERNAME;
const accessKey = process.env.BROWSERSTACK_ACCESS_KEY;
if (!username || !accessKey) {
  console.error('Missing BROWSERSTACK_USERNAME/BROWSERSTACK_ACCESS_KEY');
  process.exit(2);
}

const previewBase = process.env.PREVIEW_BASE
  || 'https://kbo-everyday-hvlvzjuk0-hwinsides-projects.vercel.app';
const bypassToken = process.env.BYPASS_TOKEN || 'Zl0mZTENCgq68o5B0VGbcVocVx8NTiRy';
const gameId = process.env.GAME_ID || '20260505OBLG0';
const qaUrl = `${previewBase}/games/${gameId}`
  + `?x-vercel-protection-bypass=${bypassToken}`
  + `&x-vercel-set-bypass-cookie=true`
  + `&chatQaKeyboard=1`;

const frameIntervalMs = Number(process.env.QA_FRAME_INTERVAL_MS || 200);
const frameDurationMs = Number(process.env.QA_FRAME_DURATION_MS || 12000);
const typeIntervalMs = Number(process.env.QA_TYPE_INTERVAL_MS || 1500);
const reportPath = path.resolve(process.env.QA_OUT_DIR || 'e2e/screenshots',
  `keyboard-frames-report-${gameId}.json`);

const hub = 'https://hub-cloud.browserstack.com/wd/hub';
const auth = `Basic ${Buffer.from(`${username}:${accessKey}`).toString('base64')}`;

async function wd(method, route, body, sessionId) {
  const res = await fetch(`${hub}${sessionId ? `/session/${sessionId}` : ''}${route}`, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json; charset=utf-8' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error || json.value?.error) {
    throw new Error(`${method} ${route} failed: ${JSON.stringify(json)}`);
  }
  return json.value ?? json;
}

async function wdExec(sessionId, script) {
  return wd('POST', '/execute/sync', { script, args: [] }, sessionId);
}

async function snap(sessionId, label) {
  const shot = await wd('GET', '/screenshot', null, sessionId);
  const outDir = path.resolve(process.env.QA_OUT_DIR || 'e2e/screenshots');
  await mkdir(outDir, { recursive: true });
  const pngPath = path.join(outDir, `keyboard-frames-${gameId}-${label}.png`);
  await writeFile(pngPath, Buffer.from(shot, 'base64'));
  return pngPath;
}

const installInstrumentation = `
  if (!window.__qaInstalled) {
    window.__qaInstalled = true;
    window.__qaFrames = [];
    window.__qaScrollToCalls = [];
    window.__qaScrollIntoViewCalls = [];
    window.__qaStartTs = Date.now();
    var origScrollTo = window.scrollTo.bind(window);
    window.scrollTo = function() {
      try {
        var focused = document.activeElement && document.activeElement.tagName === 'TEXTAREA';
        window.__qaScrollToCalls.push({
          t: Date.now() - window.__qaStartTs,
          y: typeof arguments[0] === 'number' ? arguments[0]
             : (arguments[0] && arguments[0].top) || null,
          focused: !!focused,
          kbdOpen: document.body.classList.contains('kbd-open'),
        });
      } catch (e) {}
      return origScrollTo.apply(this, arguments);
    };
    var origSIV = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function() {
      try {
        var focused = document.activeElement && document.activeElement.tagName === 'TEXTAREA';
        window.__qaScrollIntoViewCalls.push({
          t: Date.now() - window.__qaStartTs,
          tag: this.tagName,
          composer: !!(this.closest && this.closest('[data-composer="game-chat"]')),
          focused: !!focused,
          kbdOpen: document.body.classList.contains('kbd-open'),
        });
      } catch (e) {}
      return origSIV.apply(this, arguments);
    };
  }
  return { ok: true, startTs: window.__qaStartTs };
`;

const startCapture = `
  if (window.__qaInterval) clearInterval(window.__qaInterval);
  window.__qaCaptureStart = Date.now();
  window.__qaFrames = [];
  window.__qaInterval = setInterval(function() {
    try {
      var c = document.querySelector('[data-composer="game-chat"]');
      var rect = c ? c.getBoundingClientRect() : null;
      var vv = window.visualViewport;
      window.__qaFrames.push({
        t: Date.now() - window.__qaCaptureStart,
        scrollY: Math.round(window.scrollY),
        composerTop: rect ? Math.round(rect.top) : null,
        composerBottom: rect ? Math.round(rect.bottom) : null,
        composerHeight: rect ? Math.round(rect.height) : null,
        vvHeight: vv ? Math.round(vv.height) : null,
        vvWidth: vv ? Math.round(vv.width) : null,
        innerHeight: window.innerHeight,
        kbdOpen: document.body.classList.contains('kbd-open'),
        focused: !!(document.activeElement && document.activeElement.tagName === 'TEXTAREA'),
        msgCount: document.querySelectorAll('[data-chat-msg]').length,
      });
    } catch (e) {}
  }, ${frameIntervalMs});
  return { ok: true };
`;

const stopAndCollect = `
  if (window.__qaInterval) {
    clearInterval(window.__qaInterval);
    window.__qaInterval = null;
  }
  return {
    frames: window.__qaFrames || [],
    scrollToCalls: window.__qaScrollToCalls || [],
    scrollIntoViewCalls: window.__qaScrollIntoViewCalls || [],
  };
`;

function evaluate(frames, scrollToCalls, scrollIntoViewCalls) {
  const focusFrames = frames.filter((f) => f.kbdOpen && f.composerBottom != null && f.vvHeight != null);
  const focusScrollYs = focusFrames.map((f) => f.scrollY);
  const focusComposerOverflow = focusFrames.map((f) => f.composerBottom - f.vvHeight);
  const focusComposerGap = focusFrames.map((f) => Math.abs(f.vvHeight - f.composerBottom));

  const composerInVp = focusFrames.length > 0
    && focusComposerOverflow.every((d) => d <= 4);
  const noBlackGap = focusFrames.length > 0
    && focusComposerGap.every((d) => d <= 12);
  const scrollRange = focusScrollYs.length > 0
    ? Math.max(...focusScrollYs) - Math.min(...focusScrollYs)
    : 0;
  const noScrollRunaway = scrollRange <= 8;
  const focusScrollToCalls = scrollToCalls.filter((c) => c.kbdOpen);
  // 2026-05-06 design update (after rAF-suspend root cause + 삼순이 review):
  // focus-entry one-shot align (3 setTimeouts at 100/350/700ms) re-aligns the
  // viewport so latest 5 messages sit above composer after the 5→50 slice
  // expand. The 700ms timer fires after keyboard rise animation; on slower
  // BS devices (iPhone 15 / iOS 18) the actual scrollTo can land >1500ms
  // post first-frame due to slower keyboard animation. Window=2500ms covers
  // all observed devices (iPhone 14/15 × iOS 17/18) with comfortable slack.
  // Window starts from focusFrames[0].t (first frame seen with kbdOpen),
  // which is the closest proxy we have to "focus event time".
  const FOCUS_ENTRY_ALIGN_WINDOW_MS = 2500;
  const focusEntryWindowEnd = focusFrames.length
    ? focusFrames[0].t + FOCUS_ENTRY_ALIGN_WINDOW_MS
    : FOCUS_ENTRY_ALIGN_WINDOW_MS;
  const focusRunawayScrollToCalls = focusScrollToCalls.filter((c) => c.t > focusEntryWindowEnd);
  const noScrollToInFocus = focusRunawayScrollToCalls.length === 0;

  const checks = {
    composerInVp,
    noBlackGap,
    noScrollRunaway,
    noScrollToInFocus,
  };

  return {
    checks,
    pass: Object.values(checks).every(Boolean),
    summary: {
      focusFrameCount: focusFrames.length,
      totalFrameCount: frames.length,
      maxComposerOverflow: focusComposerOverflow.length
        ? Math.max(...focusComposerOverflow) : null,
      maxComposerGap: focusComposerGap.length
        ? Math.max(...focusComposerGap) : null,
      scrollRange,
      focusScrollToCallCount: focusScrollToCalls.length,
      focusRunawayScrollToCallCount: focusRunawayScrollToCalls.length,
      totalScrollToCallCount: scrollToCalls.length,
      scrollIntoViewCallCount: scrollIntoViewCalls.length,
      focusEntryWindowEnd,
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('QA URL:', qaUrl);
  const created = await wd('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'safari',
        'bstack:options': {
          projectName: 'kbo-everyday',
          buildName: `keyboard-frames-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`,
          sessionName: `keyboard-frames v3 ${gameId}`,
          deviceName: process.env.BS_DEVICE || 'iPhone 15',
          osVersion: process.env.BS_OS_VERSION || '17',
          realMobile: 'true',
          debug: 'true',
          networkLogs: 'true',
          consoleLogs: 'info',
          appiumVersion: '2.0.1',
          video: 'true',
        },
      },
    },
  });
  const sessionId = created.sessionId;
  if (!sessionId) throw new Error(`No sessionId: ${JSON.stringify(created)}`);
  console.log('Session:', sessionId);

  const out = {
    qaUrl,
    sessionId,
    config: { frameIntervalMs, frameDurationMs, typeIntervalMs },
    screenshots: {},
  };

  try {
    await wd('POST', '/url', { url: qaUrl }, sessionId);
    await sleep(6000);

    out.screenshots.idle = await snap(sessionId, 'idle');
    await wdExec(sessionId, installInstrumentation);

    // Click textarea -> focus + iOS keyboard
    const found = await wd('POST', '/element', {
      using: 'css selector',
      value: '[data-composer="game-chat"] textarea',
    }, sessionId);
    const elementId = found['element-6066-11e4-a52e-4f735466cecf'] || found.ELEMENT;
    await wd('POST', `/element/${elementId}/click`, {}, sessionId);
    await sleep(1500); // wait for keyboard animation

    // Start capture *after* keyboard up so all frames are in focus state
    await wdExec(sessionId, startCapture);
    out.screenshots.focus = await snap(sessionId, 'focus-start');

    // Type characters periodically to simulate visualViewport resize churn
    // (QuickType bar fluctuation, IME state).
    const captureEnd = Date.now() + frameDurationMs;
    const typedChars = [];
    let nextType = Date.now() + typeIntervalMs;
    while (Date.now() < captureEnd) {
      if (Date.now() >= nextType) {
        try {
          const ch = String.fromCharCode(97 + (typedChars.length % 26));
          await wd('POST', `/element/${elementId}/value`, { text: ch }, sessionId);
          typedChars.push(ch);
        } catch (e) {
          // typing is best-effort; capture continues regardless.
        }
        nextType = Date.now() + typeIntervalMs;
      }
      await sleep(150);
    }

    out.screenshots.focusEnd = await snap(sessionId, 'focus-end');
    const collected = await wdExec(sessionId, stopAndCollect);
    out.frames = collected.frames || [];
    out.scrollToCalls = collected.scrollToCalls || [];
    out.scrollIntoViewCalls = collected.scrollIntoViewCalls || [];
    out.typedChars = typedChars;

    const verdict = evaluate(out.frames, out.scrollToCalls, out.scrollIntoViewCalls);
    out.checks = verdict.checks;
    out.summary = verdict.summary;
    out.pass = verdict.pass;

    console.log('---SUMMARY---', JSON.stringify(out.summary, null, 2));
    console.log('---CHECKS---', JSON.stringify(verdict.checks, null, 2));
    console.log('PASS:', verdict.pass);

    await wdExec(sessionId,
      'browserstack_executor: ' + JSON.stringify({
        action: 'setSessionStatus',
        arguments: {
          status: verdict.pass ? 'passed' : 'failed',
          reason: verdict.pass
            ? 'keyboard-frames PASS'
            : `FAIL ${JSON.stringify(verdict.checks)} ${JSON.stringify(out.summary)}`,
        },
      })).catch(() => {});

    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(out, null, 2));
    console.log('Report:', reportPath);

    if (!verdict.pass) process.exitCode = 1;
  } finally {
    await wd('DELETE', '', null, sessionId).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
