#!/usr/bin/env node
/**
 * Real-device QA for iOS Safari keyboard layout on BrowserStack.
 *
 * Required env:
 *   BROWSERSTACK_USERNAME
 *   BROWSERSTACK_ACCESS_KEY
 * Optional env:
 *   QA_URL=https://keubo.fan/games/20260502NCLG0?chatDebug=1
 *   BS_DEVICE='iPhone 15'
 *   BS_OS_VERSION='17'
 *
 * This intentionally uses raw W3C WebDriver over fetch so the repo does not
 * need heavy Selenium/Appium dependencies just to run this smoke test.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const username = process.env.BROWSERSTACK_USERNAME;
const accessKey = process.env.BROWSERSTACK_ACCESS_KEY;
if (!username || !accessKey) {
  console.error('Missing BROWSERSTACK_USERNAME/BROWSERSTACK_ACCESS_KEY');
  process.exit(2);
}

const hub = 'https://hub-cloud.browserstack.com/wd/hub';
const auth = `Basic ${Buffer.from(`${username}:${accessKey}`).toString('base64')}`;
const qaUrl = process.env.QA_URL || 'https://keubo.fan/games/20260502NCLG0?chatDebug=1&chatQaKeyboard=1';

async function wd(method, route, body, sessionId) {
  const res = await fetch(`${hub}${sessionId ? `/session/${sessionId}` : ''}${route}`, {
    method,
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error || json.value?.error) {
    throw new Error(`${method} ${route} failed: ${JSON.stringify(json)}`);
  }
  return json.value ?? json;
}

async function main() {
  const created = await wd('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'safari',
        'bstack:options': {
          projectName: 'kbo-everyday',
          buildName: `game-chat-keyboard-${new Date().toISOString().slice(0, 10)}`,
          sessionName: 'iOS Safari game chat keyboard gap',
          deviceName: process.env.BS_DEVICE || 'iPhone 15',
          osVersion: process.env.BS_OS_VERSION || '17',
          realMobile: 'true',
          debug: 'true',
          networkLogs: 'true',
          consoleLogs: 'info',
        },
      },
    },
  });
  const sessionId = created.sessionId;
  if (!sessionId) throw new Error(`No sessionId: ${JSON.stringify(created)}`);

  try {
    await wd('POST', '/url', { url: qaUrl }, sessionId);
    await new Promise((r) => setTimeout(r, 5000));

    const found = await wd('POST', '/element', {
      using: 'css selector',
      value: '[data-composer="game-chat"] input',
    }, sessionId);
    const elementId = found['element-6066-11e4-a52e-4f735466cecf'] || found.ELEMENT;
    await wd('POST', `/element/${elementId}/click`, {}, sessionId);
    await new Promise((r) => setTimeout(r, 2500));

    // Try a real touch scroll while keyboard is open. This exposes the translucent
    // accessory/autocomplete gap if the app does not cover the layout viewport
    // below the composer with an opaque layer.
    await wd('POST', '/actions', {
      actions: [{
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: 200, y: 430 },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 100 },
          { type: 'pointerMove', duration: 450, x: 200, y: 250 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    }, sessionId);
    await new Promise((r) => setTimeout(r, 1000));

    const metrics = await wd('POST', '/execute/sync', {
      script: `
        const composer = document.querySelector('[data-composer="game-chat"]');
        const msgs = [...document.querySelectorAll('[data-chat-msg]')];
        const last = msgs[msgs.length - 1];
        const rect = (el) => el ? JSON.parse(JSON.stringify(el.getBoundingClientRect())) : null;
        return {
          ua: navigator.userAgent,
          debugText: document.body.innerText.match(/focus ih=.*?frame=1/)?.[0] || null,
          messageCount: msgs.length,
          composer: rect(composer),
          lastMessage: rect(last),
          gapToComposer: composer && last ? composer.getBoundingClientRect().top - last.getBoundingClientRect().bottom : null,
          scrollY: window.scrollY,
          visualViewport: window.visualViewport ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            offsetTop: window.visualViewport.offsetTop,
          } : null,
        };
      `,
      args: [],
    }, sessionId);

    const shot = await wd('GET', '/screenshot', null, sessionId);
    const outDir = path.resolve('e2e/screenshots');
    await mkdir(outDir, { recursive: true });
    const pngPath = path.join(outDir, 'browserstack-ios-keyboard-gap.png');
    await writeFile(pngPath, Buffer.from(shot, 'base64'));

    console.log(JSON.stringify({ qaUrl, pngPath, metrics }, null, 2));

    const pass = metrics.messageCount === 5
      && typeof metrics.gapToComposer === 'number'
      && metrics.gapToComposer <= 16
      && metrics.composer?.bottom <= (metrics.visualViewport?.height ?? Number.POSITIVE_INFINITY) + 4;

    await wd('POST', '/execute/sync', {
      script: 'browserstack_executor: ' + JSON.stringify({ action: 'setSessionStatus', arguments: { status: pass ? 'passed' : 'failed', reason: pass ? 'Keyboard layout smoke passed' : `Keyboard layout smoke failed: ${JSON.stringify(metrics)}` } }),
      args: [],
    }, sessionId).catch(() => {});

    if (!pass) process.exit(1);
  } finally {
    await wd('DELETE', '', null, sessionId).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
