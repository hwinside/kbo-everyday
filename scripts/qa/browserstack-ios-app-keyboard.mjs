#!/usr/bin/env node
/**
 * BrowserStack App Automate QA for iOS keyboard/chat stability.
 *
 * Why App Automate instead of Safari Automate:
 * - BrowserStack Safari WebDriver sessions can focus/sendKeys without rendering
 *   the real iOS software keyboard.
 * - A Capacitor WKWebView app session can be tapped through native Appium touch
 *   actions, and BrowserStack records the real keyboard/session video.
 *
 * Prereq: upload a QA iOS IPA whose Capacitor server.url points to:
 *   https://keubo.fan/games/20260502NCLG0?chatDebug=1&chatQaKeyboard=1
 * Current uploaded QA app: bs://3443870596a5eb21b4ecd596c019338b444324e0
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const username = process.env.BROWSERSTACK_USERNAME;
const accessKey = process.env.BROWSERSTACK_ACCESS_KEY;
const app = process.env.BROWSERSTACK_IOS_APP_URL
  || process.env.BROWSERSTACK_APP_URL
  || process.env.BS_APP
  || 'bs://3443870596a5eb21b4ecd596c019338b444324e0';
const outDir = process.env.QA_OUT_DIR || path.resolve('e2e/screenshots');
const beforePath = path.join(outDir, 'browserstack-ios-app-keyboard-open.png');
const afterPath = path.join(outDir, 'browserstack-ios-app-keyboard-after-drag.png');
const reportPath = path.join(outDir, 'browserstack-ios-app-keyboard-report.json');

if (!username || !accessKey) {
  console.error('Missing BROWSERSTACK_USERNAME/BROWSERSTACK_ACCESS_KEY');
  process.exit(2);
}

const hub = 'https://hub-cloud.browserstack.com/wd/hub';
const apiBase = 'https://api-cloud.browserstack.com/app-automate';
const auth = `Basic ${Buffer.from(`${username}:${accessKey}`).toString('base64')}`;

async function wd(method, route, body, sessionId, ok = [200]) {
  const res = await fetch(`${hub}${sessionId ? `/session/${sessionId}` : ''}${route}`, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!ok.includes(res.status)) {
    throw new Error(`${method} ${route} -> ${res.status}: ${text.slice(0, 1200)}`);
  }
  return data.value ?? data;
}

async function api(pathname) {
  const res = await fetch(`${apiBase}${pathname}`, { headers: { Authorization: auth } });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function touchAction(sessionId, actions) {
  return wd('POST', '/actions', {
    actions: [{ type: 'pointer', id: `finger-${Date.now()}`, parameters: { pointerType: 'touch' }, actions }],
  }, sessionId);
}

async function tap(sessionId, x, y) {
  await touchAction(sessionId, [
    { type: 'pointerMove', duration: 0, x, y },
    { type: 'pointerDown', button: 0 },
    { type: 'pause', duration: 80 },
    { type: 'pointerUp', button: 0 },
  ]);
}

async function drag(sessionId, x, y1, y2) {
  await touchAction(sessionId, [
    { type: 'pointerMove', duration: 0, x, y: y1 },
    { type: 'pointerDown', button: 0 },
    { type: 'pause', duration: 120 },
    { type: 'pointerMove', duration: 550, x, y: y2 },
    { type: 'pointerUp', button: 0 },
  ]);
}

function center(el) {
  return { x: Math.round(el.x + el.width / 2), y: Math.round(el.y + el.height / 2) };
}

function findComposerTapPoint(source) {
  const elements = parseElements(source);
  const input = elements.find((el) =>
    el.visible === 'true'
    && (el.kind === 'TextField' || el.kind === 'StaticText')
    && /메시지 입력/.test(el.label || el.name || el.value || '')
  );
  if (input) return center(input);

  // Fallback for the rounded composer container in iPhone 15 portrait.
  return { x: 160, y: 780 };
}

function parseElements(source) {
  const elements = [];
  const tagRe = /<XCUIElementType(StaticText|TextField|Button|Keyboard)\b[^>]*>/g;
  const attrRe = /(type|value|name|label|visible|x|y|width|height)="([^"]*)"/g;
  let match;
  while ((match = tagRe.exec(source))) {
    const tag = match[0];
    const attrs = { kind: match[1] };
    let a;
    while ((a = attrRe.exec(tag))) attrs[a[1]] = a[2];
    attrs.x = Number(attrs.x);
    attrs.y = Number(attrs.y);
    attrs.width = Number(attrs.width);
    attrs.height = Number(attrs.height);
    elements.push(attrs);
  }
  return elements;
}

function stableChatTexts(source) {
  const seen = new Set();
  return parseElements(source)
    .filter((el) => el.kind === 'StaticText' && el.visible === 'true')
    .filter((el) => el.y >= 280 && el.y <= 680 && el.height > 10)
    .filter((el) => {
      const label = el.label || el.name || el.value || '';
      if (!label || label.length > 60) return false;
      if (/^(LG|NC|\d{2}:\d{2}|윤연률|무적LG트윈스|📊|🏆|경기 분석|순위 영향|실시간|전체 채팅|Done)$/.test(label)) return false;
      if (seen.has(label)) return false;
      seen.add(label);
      return true;
    })
    .map((el) => ({ label: el.label || el.name || el.value, x: el.x, y: el.y, height: el.height }));
}

function comparePositions(before, after) {
  const byLabel = new Map(after.map((el) => [el.label, el]));
  return before
    .map((b) => ({ label: b.label, beforeY: b.y, afterY: byLabel.get(b.label)?.y, deltaY: byLabel.has(b.label) ? Math.round((byLabel.get(b.label).y - b.y) * 10) / 10 : null }))
    .filter((row) => row.afterY != null);
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const caps = {
    capabilities: {
      alwaysMatch: {
        platformName: 'iOS',
        'appium:app': app,
        'appium:autoAcceptAlerts': true,
        'appium:newCommandTimeout': 120,
        'bstack:options': {
          userName: username,
          accessKey,
          projectName: 'kbo-everyday',
          buildName: `game-chat-ios-app-keyboard-${new Date().toISOString().slice(0, 10)}`,
          sessionName: 'GameChat iOS keyboard native Appium QA',
          deviceName: process.env.BS_DEVICE || 'iPhone 15',
          osVersion: process.env.BS_OS || '17',
          appiumVersion: '2.15.0',
          debug: true,
          video: true,
        },
      },
    },
  };

  let sessionId;
  let sessionInfo = null;
  try {
    const created = await wd('POST', '/session', caps, null, [200, 201]);
    sessionId = created.sessionId;

    // Wait for the QA URL to load in the Capacitor WKWebView.
    await sleep(Number(process.env.QA_INITIAL_WAIT_MS || 20000));

    // Resolve the composer from the native accessibility tree. This still uses
    // a native touch tap, but avoids stale hard-coded y coordinates when composer
    // bottom spacing changes.
    const initialSource = String(await wd('GET', '/source', null, sessionId));
    const tapPoint = findComposerTapPoint(initialSource);
    await tap(sessionId, tapPoint.x, tapPoint.y);
    await sleep(3500);

    const beforeSource = String(await wd('GET', '/source', null, sessionId));
    const beforePng = await wd('GET', '/screenshot', null, sessionId);
    await fs.writeFile(beforePath, Buffer.from(beforePng, 'base64'));

    // Attempt to drag the chat preview area while keyboard is open. A passing
    // frozen-preview implementation should not move visible chat text or reveal
    // underlying scroll content.
    await drag(sessionId, 180, 610, 430);
    await sleep(1200);

    const afterSource = String(await wd('GET', '/source', null, sessionId));
    const afterPng = await wd('GET', '/screenshot', null, sessionId);
    await fs.writeFile(afterPath, Buffer.from(afterPng, 'base64'));

    const beforeTexts = stableChatTexts(beforeSource);
    const afterTexts = stableChatTexts(afterSource);
    const deltas = comparePositions(beforeTexts, afterTexts);
    const maxDeltaY = Math.max(0, ...deltas.map((row) => Math.abs(row.deltaY ?? 0)));
    const keyboardVisible = /XCUIElementTypeKeyboard|Done|return|space/.test(afterSource);
    const enoughTrackedTexts = deltas.length >= 3;

    await wd('DELETE', '', null, sessionId, [200]);
    await sleep(4000);
    sessionInfo = await api(`/sessions/${sessionId}.json`);

    const automation = sessionInfo.automation_session || sessionInfo;
    const report = {
      sessionId,
      app,
      beforePath,
      afterPath,
      browserstackSessionUrl: automation.public_url || automation.browser_url || null,
      videoUrl: automation.video_url || null,
      tapPoint,
      keyboardVisible,
      trackedTexts: deltas,
      maxDeltaY,
      enoughTrackedTexts,
      pass: keyboardVisible && enoughTrackedTexts && maxDeltaY <= 1,
    };
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.pass) process.exitCode = 1;
  } finally {
    if (sessionId) {
      try { await wd('DELETE', '', null, sessionId, [200]); } catch {}
    }
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
