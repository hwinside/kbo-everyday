#!/usr/bin/env node
/**
 * Real-device QA for the venue story viewer bottom comment composer on iOS Safari
 * (BrowserStack). 삼순 #807 라운드3 blocker 2 — game-chat 전용이던
 * browserstack-ios-safari-keyboard.mjs 는 `[data-composer="game-chat"]` 만 보므로
 * 스토리 입력바(`[data-composer="venue-story"]`) 전용 focus→키보드 frames→submit→blur
 * 검증을 별도로 수행한다.
 *
 * Required env:
 *   BROWSERSTACK_USERNAME
 *   BROWSERSTACK_ACCESS_KEY
 * Optional env:
 *   QA_URL   (default: PR #807 Vercel preview /games/20260502NCLG0?storyQaKeyboard=1)
 *   BS_DEVICE='iPhone 15'
 *   BS_OS_VERSION='17'
 *
 * `?storyQaKeyboard=1` 은 VenueStorySection 의 QA 모드 — 실제 스토리/로그인 없이
 * mock 스토리로 뷰어를 자동 오픈한다(진행/종료 없는 무음 video 라 측정 동안 유지).
 * Raw W3C WebDriver over fetch — Selenium/Appium 의존성 불필요(기존 스크립트와 동일).
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
const qaUrl = process.env.QA_URL
  || 'https://kbo-everyday-git-feat-venue-story-comments-hwinsides-projects.vercel.app/games/20260502NCLG0?storyQaKeyboard=1';

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

const METRICS_SCRIPT = `
  const composer = document.querySelector('[data-composer="venue-story"]');
  const viewer = document.querySelector('[data-venue-story-viewer]');
  const input = composer ? composer.querySelector('input') : null;
  const rect = (el) => el ? JSON.parse(JSON.stringify(el.getBoundingClientRect())) : null;
  return {
    ua: navigator.userAgent,
    hasComposer: Boolean(composer),
    inputFocused: Boolean(input && document.activeElement === input),
    inputValue: input ? input.value : null,
    composer: rect(composer),
    viewer: rect(viewer),
    innerHeight: window.innerHeight,
    scrollY: window.scrollY,
    pageYOffset: window.pageYOffset,
    documentElementScrollTop: document.documentElement.scrollTop,
    bodyScrollTop: document.body.scrollTop,
    bodyPosition: document.body.style.position,
    bodyTop: document.body.style.top,
    htmlOverflow: document.documentElement.style.overflow,
    visualViewport: window.visualViewport ? {
      width: window.visualViewport.width,
      height: window.visualViewport.height,
      offsetTop: window.visualViewport.offsetTop,
    } : null,
  };
`;

async function metrics(sessionId) {
  return wd('POST', '/execute/sync', { script: METRICS_SCRIPT, args: [] }, sessionId);
}

// 실기기 키보드 오픈/닫힘은 애니메이션+이벤트 지연이 있어 고정 sleep 대신
// 조건 충족까지 폴링한다(최대 timeoutMs, 마지막 측정치 반환).
async function waitMetrics(sessionId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let m = await metrics(sessionId);
  while (!predicate(m) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    m = await metrics(sessionId);
  }
  return m;
}

async function drag(sessionId, x, y1, y2) {
  await wd('POST', '/actions', {
    actions: [{
      type: 'pointer',
      id: 'drag-finger',
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x, y: y1 },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerMove', duration: 700, x, y: y2 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  }, sessionId);
}

const kbOpen = (m) => m.visualViewport != null && m.innerHeight - m.visualViewport.height > 120;
const composerFlushWithKeyboard = (m) =>
  m.composer != null && m.visualViewport != null
  && Math.abs(
    m.composer.bottom - (m.visualViewport.offsetTop + m.visualViewport.height)
  ) <= 4;
const sameRootAndViewer = (a, b) =>
  a.viewer != null && b.viewer != null
  && Math.abs(a.viewer.top - b.viewer.top) <= 1
  && Math.abs(a.viewer.bottom - b.viewer.bottom) <= 1
  && b.scrollY === a.scrollY
  && b.pageYOffset === a.pageYOffset
  && b.documentElementScrollTop === a.documentElementScrollTop
  && b.bodyScrollTop === a.bodyScrollTop;

async function main() {
  const created = await wd('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'safari',
        'bstack:options': {
          projectName: 'kbo-everyday',
          buildName: `venue-story-comments-keyboard-${new Date().toISOString().slice(0, 10)}`,
          sessionName: 'iOS Safari venue story comment composer keyboard',
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
    await new Promise((r) => setTimeout(r, 6000));

    // 0) 댓글 모달 오픈 — 하단 댓글 버튼(data-open-comments) 탭으로 바텀시트를 띄운다.
    //    인라인 입력바가 아니라 모달(탭→모달) 방식이므로 컴포저는 모달이 열려야 DOM 에 마운트된다.
    //    모달 오픈은 키보드가 필요 없어 programmatic click 로 충분.
    await wd('POST', '/execute/sync', {
      script: "const b = document.querySelector('[data-open-comments]'); if (b) b.click(); return Boolean(b);",
      args: [],
    }, sessionId);
    await waitMetrics(sessionId, (m) => m.hasComposer, 6000);

    const idle = await metrics(sessionId);

    // 1) focus — 입력바 input 을 네이티브 터치로 탭해 소프트웨어 키보드를 띄운다.
    //    element click 은 programmatic focus 라 키보드가 안 뜨고, nativeWebTap 은
    //    하단 고정 입력바에서 iOS17 하단 주소창을 오탭한다 → pointer actions(네이티브
    //    좌표 = 웹 좌표 + 상단 크롬 오프셋)로 직접 탭하며, 오프셋은 후보군을
    //    순회하며 inputFocused 로 자가보정한다(기기/OS 별 크롬 높이 차이 흡수).
    if (!idle.composer) throw new Error('composer rect unavailable');
    const tapX = Math.round(idle.composer.x + idle.composer.width * 0.4);
    const webY = Math.round(idle.composer.y + idle.composer.height / 2);
    let focused = null;
    for (const topOffset of [59, 50, 70, 40, 80, 94, 100]) {
      await wd('POST', '/actions', {
        actions: [{
          type: 'pointer',
          id: 'finger1',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: tapX, y: webY + topOffset },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 80 },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      }, sessionId);
      focused = await waitMetrics(
        sessionId,
        (m) => m.inputFocused && kbOpen(m) && composerFlushWithKeyboard(m),
        6000,
      );
      if (focused.inputFocused) break;
    }

    // 2) type — 실제 키 입력(키보드 frame 유지 확인).
    //    탭 후 리렌더로 element 참조가 stale 될 수 있어 포커스 후에 조회한다.
    const found = await wd('POST', '/element', {
      using: 'css selector',
      value: '[data-composer="venue-story"] input',
    }, sessionId);
    const elementId = found['element-6066-11e4-a52e-4f735466cecf'] || found.ELEMENT;
    await wd('POST', `/element/${elementId}/value`, { text: 'QA 키보드 확인' }, sessionId);
    await new Promise((r) => setTimeout(r, 1200));
    const typed = await metrics(sessionId);

    // 3) keyboard-open native drag — JS scrollBy 가 아니라 실기기 touch drag 로 뷰어를
    // 끌어도 viewer rect·raw document scroll 4종·root lock 이 그대로인지 검증한다.
    const beforeDrag = typed;
    await drag(sessionId, 180, 360, 590);
    await new Promise((r) => setTimeout(r, 1200));
    const afterDrag = await metrics(sessionId);

    // 4) submit — 전송 버튼 탭(비로그인이라 서버 쓰기 없음 — 로그인 안내 토스트 경로).
    //    submit 후에도 composer 가 키보드 위에 유지되는지 확인.
    const submit = await wd('POST', '/element', {
      using: 'css selector',
      value: '[data-composer="venue-story"] [aria-label="댓글 등록"]',
    }, sessionId);
    const submitId = submit['element-6066-11e4-a52e-4f735466cecf'] || submit.ELEMENT;
    await wd('POST', '/execute/sync', {
      script: 'arguments[0].click();',
      args: [{ 'element-6066-11e4-a52e-4f735466cecf': submitId }],
    }, sessionId);
    await new Promise((r) => setTimeout(r, 1500));
    const submitted = await metrics(sessionId);

    // 5) blur — 키보드 닫힘 → 인셋 해제, composer 하단 복귀
    await wd('POST', '/execute/sync', {
      script: 'if (document.activeElement && document.activeElement.blur) document.activeElement.blur();',
      args: [],
    }, sessionId);
    const blurred = await waitMetrics(
      sessionId,
      (m) => !m.inputFocused && !kbOpen(m),
      12000,
    );

    const shot = await wd('GET', '/screenshot', null, sessionId);
    const outDir = path.resolve('e2e/screenshots');
    await mkdir(outDir, { recursive: true });
    const pngPath = path.join(outDir, 'browserstack-ios-story-comments-keyboard.png');
    await writeFile(pngPath, Buffer.from(shot, 'base64'));

    const result = { qaUrl, pngPath, idle, focused, typed, beforeDrag, afterDrag, submitted, blurred };
    console.log(JSON.stringify(result, null, 2));

    const pass = idle.hasComposer
      // focus: 키보드 frame(시각 뷰포트 축소) + 입력바가 키보드 위에 노출 + 실제 포커스
      && focused.inputFocused && kbOpen(focused) && composerFlushWithKeyboard(focused)
      && sameRootAndViewer(idle, focused)
      // type: 값 반영 + 키보드 유지
      && typed.inputValue === 'QA 키보드 확인' && kbOpen(typed) && composerFlushWithKeyboard(typed)
      && sameRootAndViewer(idle, typed)
      // native drag: 키보드·입력바 유지 + 뷰어 위치와 raw root scroll 불변 + 실제 lock style
      && kbOpen(afterDrag) && composerFlushWithKeyboard(afterDrag)
      && sameRootAndViewer(idle, afterDrag)
      && sameRootAndViewer(beforeDrag, afterDrag)
      && afterDrag.bodyPosition === 'fixed'
      && afterDrag.htmlOverflow === 'hidden'
      // submit: 키보드 유지 중에도 입력바 가려지지 않음
      && kbOpen(submitted) && composerFlushWithKeyboard(submitted)
      && sameRootAndViewer(idle, submitted)
      // blur: 키보드 해제 + 인셋 복귀(입력바가 레이아웃 뷰포트 하단으로)
      && !blurred.inputFocused && !kbOpen(blurred);

    await wd('POST', '/execute/sync', {
      script: 'browserstack_executor: ' + JSON.stringify({
        action: 'setSessionStatus',
        arguments: {
          status: pass ? 'passed' : 'failed',
          reason: pass
            ? 'Venue story composer keyboard smoke passed'
            : 'Venue story composer keyboard smoke failed (see logged metrics)',
        },
      }),
      args: [],
    }, sessionId).catch(() => {});

    console.log(pass ? 'PASS' : 'FAIL');
    if (!pass) process.exit(1);
  } finally {
    await wd('DELETE', '', null, sessionId).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
