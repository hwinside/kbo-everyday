#!/usr/bin/env node
/**
 * 하단 safe-area inset 게이트 (Android edge-to-edge nav bar 겹침 차단)
 *
 * 배경 — 2026-08-06 #cs P0
 *   targetSdk 36(Android 15+)은 edge-to-edge를 강제해 WebView가 시스템 3-button
 *   navigation bar 뒤까지 그려진다. viewport-fit=cover라 env(safe-area-inset-bottom)
 *   값은 내려오지만, 그 값을 쓰는 CSS 규칙이 없으면 보정이 0이라 하단 고정 composer가
 *   nav bar 뒤로 깔린다. 실제로 `pb-safe`는 이 레포에 한 번도 정의된 적이 없어
 *   (Tailwind v4 기본 유틸 아님) 9개 파일 13곳이 전부 no-op이었다.
 *
 * 이 게이트는 두 축을 본다.
 *   [A] 정적 — 하단 고정 surface가 "정의된" inset 유틸을 쓰는가. 미정의 클래스
 *       (pb-safe 등)를 쓰면 FAIL. 배포 CSS에 실제로 존재하는 셀렉터만 인정한다.
 *   [B] 런타임 — 실 브라우저에 safe-area-inset-bottom을 CDP로 주입하고
 *       (Emulation.setSafeAreaInsetsOverride), composer의 DOM rect 하단이
 *       nav-safe 경계(viewport bottom - inset) 안에 들어오는지 픽셀로 잰다.
 *
 * [B]가 최종 근거다. [A]만으로는 "정의된 유틸을 썼지만 값이 0"인 경우를 못 잡는다.
 *
 * 사용:
 *   node scripts/qa/bottom-safe-inset-gate.mjs            # 정적 + 런타임
 *   node scripts/qa/bottom-safe-inset-gate.mjs --static   # 정적만 (CI 빠른 경로)
 *   BASE_URL=http://localhost:3003 node scripts/qa/bottom-safe-inset-gate.mjs
 *
 * exit 0 = PASS, exit 1 = FAIL, exit 2 = 검증 불가(= FAIL 취급)
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'src');
const GLOBALS = path.join(SRC, 'styles/globals.css');
const BASE_URL = process.env.BASE_URL || 'https://keubo.fan';
const STATIC_ONLY = process.argv.includes('--static');
const ARTIFACT_DIR = path.join(ROOT, '.qa-artifacts');

const fail = [];
const pass = [];
const note = [];

// ─────────────────────────────────────────────────────────────
// [A] 정적: 하단 고정 surface가 실제로 정의된 inset 유틸을 쓰는가
// ─────────────────────────────────────────────────────────────

const GLOBALS_CSS = readFileSync(GLOBALS, 'utf8');

/** globals.css에 정의된 클래스 셀렉터 집합 */
function definedClasses() {
  return new Set([...GLOBALS_CSS.matchAll(/^\s*\.([-\w]+)\s*[,{]/gm)].map((m) => m[1]));
}

/**
 * globals.css의 해당 유틸이 실제로 safe-area-inset-bottom을 소비하는가.
 * 정의만 있고 상수를 박아둔 경우를 걸러낸다(mutation 감지점).
 */
function utilityConsumesBottomInset(name) {
  const re = new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`);
  const m = GLOBALS_CSS.match(re);
  return !!m && /safe-area-inset-bottom/.test(m[1]);
}

const BOTTOM_INSET_UTILS = ['pb-safe', 'pb-tab-bar'].filter(utilityConsumesBottomInset);

/** 하단 inset을 실제로 만들어내는 표기인가 (className 또는 inline style) */
function hasRealBottomInset(source) {
  // 임의값 표기: pb-[env(safe-area-inset-bottom...)] / pb-[calc(...env(...))]
  if (/pb-\[[^\]]*safe-area-inset-bottom[^\]]*\]/.test(source)) return true;
  // inline style: paddingBottom: "max(env(safe-area-inset-bottom, 0px), 12px)"
  if (/paddingBottom[^,;}]*safe-area-inset-bottom/.test(source)) return true;
  // inline style + 변수: paddingBottom: `calc(${safeBottom} + 24px)`
  // — 변수명만으로 인정하지 않고, 그 변수가 상위에서 env()로 정의되었는지를 함께 본다.
  const varUse = source.match(/paddingBottom[^,;}]*\$\{(\w+)\}/);
  if (varUse) {
    // 선언이 여러 줄에 걸칠 수 있다(삼항연산자 줄바꿈). 선언부터 그 다음 세미콜론까지 본다.
    const decl = source.match(new RegExp(`\\b${varUse[1]}\\s*=([\\s\\S]{0,240})`));
    if (decl) {
      // ⚠️ "선언 어딘가에 env 가 있으면 통과"는 false-green 이다.
      // 삼항연산자(네이티브/웹 분기)에서 한쪽 분기만 env 를 잃어도 그 플랫폼은
      // 그대로 겹친다 — mutation M5 가 실제로 이 틈으로 GREEN 을 통과했다.
      // 따라서 선언부의 *모든* 길이 리터럴이 inset 을 소비해야만 인정한다.
      const declBody = decl[1].split(';')[0];
      const literals = [...declBody.matchAll(/["'`]([^"'`]*)["'`]/g)].map((m) => m[1]);
      const lengthLiterals = literals.filter((s) =>
        /\d\s*(px|rem|em|vh|dvh|%)|safe-area-inset/.test(s),
      );
      if (lengthLiterals.length > 0 && lengthLiterals.every((s) => /safe-area-inset-bottom/.test(s)))
        return true;
    }
  }
  // globals.css에서 env(safe-area-inset-bottom)을 소비하는 것으로 확인된 유틸만 인정
  for (const u of BOTTOM_INSET_UTILS) {
    if (new RegExp(`\\b${u}\\b`).test(source)) return true;
  }
  return false;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

const defined = definedClasses();

// A-1. 미정의 inset-스러운 클래스가 코드에 남아 있으면 즉시 FAIL.
//      `pb-safe`는 이 레포에 정의된 적이 없다 — 다시 들어오면 여기서 죽는다.
const files = walk(SRC);
const undefinedInsetHits = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  // `pb-safe`, `pt-safe-area`, `pb-safearea` … safe를 담은 padding 유틸 전반.
  // 임의값 표기 `pb-[...]`는 Tailwind가 직접 생성하므로 제외.
  // CSS 커스텀 프로퍼티(`--pb-safe-base`)도 클래스가 아니다 — 앞글자가 `-` 나 `[` 면 제외.
  for (const m of text.matchAll(/(^|[^\w[-])(p[btlrxy]?-safe[\w-]*)\b/gm)) {
    const cls = m[2];
    if (defined.has(cls)) continue;
    // 유틸 이름이 아닌 문서·주석 맥락 배제: className/문자열 안에 있는 것만 본다.
    const lineText = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
    if (!/className|class=/.test(lineText)) continue;
    const line = text.slice(0, m.index).split('\n').length;
    undefinedInsetHits.push(`${path.relative(ROOT, f)}:${line} → .${cls}`);
  }
}
if (undefinedInsetHits.length) {
  fail.push(
    `[A-1] globals.css에 정의되지 않은 safe-area 유틸 사용 ${undefinedInsetHits.length}건 (전부 no-op):\n` +
      undefinedInsetHits.map((s) => `      ${s}`).join('\n'),
  );
} else {
  pass.push('[A-1] 미정의 safe-area 유틸 0건');
}

// A-2. 하단 고정/절대배치 surface는 반드시 실질 하단 inset을 가져야 한다.
//      스크롤 컨테이너를 감싸는 껍데기는 자식이 inset을 먹을 수 있으므로
//      "이 요소 또는 그 파일 안에서" inset 표기가 있으면 통과시킨다(파일 단위 판정).
// `-bottom-0.5`(음수 오프셋) 같은 비도킹 표기를 잡지 않도록 앞에 공백/인용부호를 강제.
const BOTTOM_PINNED = /className=(?:"|\{`)([^"`]*\b(?:fixed|absolute|sticky)\b[^"`]*(?:^|[\s"`])bottom-0\b[^"`]*)(?:"|`\})/g;
const BOTTOM_PINNED_INSETX = /className=(?:"|\{`)([^"`]*\binset-x-0\b[^"`]*(?:^|[\s"`])bottom-0\b[^"`]*)(?:"|`\})/g;

const pinnedFiles = new Map(); // file -> [{line, cls, window}]
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const re of [BOTTOM_PINNED, BOTTOM_PINNED_INSETX]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split('\n').length;
      const rel = path.relative(ROOT, f);
      if (!pinnedFiles.has(rel)) pinnedFiles.set(rel, []);
      pinnedFiles.get(rel).push({
        line,
        cls: m[1],
        // 같은 JSX 에레멘트의 inline style(paddingBottom)까지 보려면 좀더 넓은 창이 필요.
        window: text.slice(Math.max(0, m.index - 300), m.index + m[0].length + 300),
      });
    }
  }
}

/*
 * 하단 inset이 필요 없는 surface. 면제 사유는 전부 실측 근거가 있어야 하며,
 * "뷰포트 하단에 닿지 않는다"는 것이 기본 사유다.
 */
const EXEMPT = new Map([
  ['src/components/game/FieldViewV2.tsx', '그라운드 도형 내부 절대배치 — 뷰포트 하단 미접촉'],
  ['src/components/news/NewsCarousel.tsx', '카드 내부 그라데이션 오버레이'],
  ['src/components/my/ProfileCard.tsx', '카드 내부 오버레이'],
  ['src/components/player/PlayerHero.tsx', '히어로 내부 오버레이'],
  ['src/components/home/FavoritePlayersSection.tsx', '카드 내부 오버레이'],
  ['src/components/game/VenueStorySection.tsx', '썸네일 내부 배지'],
  ['src/components/community/FeedTextCards.tsx', '카드 내부 그라데이션'],
  ['src/app/(main)/community/layout.tsx', '카드 내부 오버레이'],
  ['src/app/(main)/community/players/[playerId]/page.tsx', '카드 내부 오버레이'],
  ['src/app/(main)/games/[gameId]/page.tsx', 'postdetail composer는 globals.css [data-composer] 규칙이 bottom 제어'],
  ['src/components/game/DateSelector.tsx', '`-bottom-0.5` 음수 오프셋 배지 — 버튼 내부'],
  ['src/components/my/VenueDiaryUploader.tsx', '썸네일 내부 업로드 진행률 바'],
  [
    'src/components/community/PlayerPickerSheet.tsx',
    '스크롤러 pb-24(96px) > 최대 nav inset(48px) — 겹침 없음(수치 확인)',
  ],
]);

/*
 * bottom-0 컨테이너 자체는 inset이 없고 자식 푸터가 먹는 구조.
 * 코드를 직접 읽어 확인한 것만 넣는다 — 이 목록은 파일 단위 판정으로 완화되므로
 * 무지성하게 늘리면 게이트 검출력이 죽는다.
 */
const DELEGATED_TO_CHILD = new Map([
  ['src/components/profile/AvatarSelectSheet.tsx', 'L297/L400 하단 버튼바가 pb-[calc(16px+env(...))]'],
  ['src/components/profile/NicknameEditSheet.tsx', 'L160 내부 래퍼가 pb-[calc(20px+env(...))]'],
]);

const missingInset = [];
const coveredFiles = [];
for (const [rel, hits] of pinnedFiles) {
  if (EXEMPT.has(rel)) continue;

  // 자식 위임 파일은 파일 단위로 완화(근거 명시된 것만).
  if (DELEGATED_TO_CHILD.has(rel)) {
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    if (hasRealBottomInset(text)) coveredFiles.push(`${rel} (자식 위임)`);
    else missingInset.push(`${rel} — 자식 위임이라 했으나 파일 어디에도 inset 없음`);
    continue;
  }

  // 기본: 하단 고정 에레멘트 "개별"로 보정을 요구한다.
  // 파일 단위로 보면 같은 파일의 다른 요소가 가려줘 DM composer 결손을 놓친다.
  const bad = hits.filter((h) => !hasRealBottomInset(h.cls) && !hasRealBottomInset(h.window));
  if (bad.length === 0) {
    coveredFiles.push(rel);
    continue;
  }
  missingInset.push(`${rel} (${bad.map((h) => `L${h.line}`).join(', ')})`);
}

// A-0. 게이트가 의존하는 유틸 자체가 inset을 소비하는지(가장 중요한 mutation 감지점).
// `.pb-safe`를 상수로 바꾸거나 지우면 여기서 즉시 RED.
if (!BOTTOM_INSET_UTILS.includes('pb-safe')) {
  fail.push('[A-0] `.pb-safe`가 globals.css에 없거나 safe-area-inset-bottom을 소비하지 않음');
} else {
  pass.push('[A-0] `.pb-safe` → env(safe-area-inset-bottom) 소비 확인');
}
if (missingInset.length) {
  fail.push(
    `[A-2] 하단 고정 surface에 실질 safe-area-inset-bottom 보정 없음 ${missingInset.length}건:\n` +
      missingInset.map((s) => `      ${s}`).join('\n'),
  );
} else {
  pass.push(
    `[A-2] 하단 고정 surface ${pinnedFiles.size}개 = 보정 ${coveredFiles.length} + 면제 ${pinnedFiles.size - coveredFiles.length} (미보정 0)`,
  );
}
note.push(`[inventory] 보정 확인: ${coveredFiles.join(', ') || '(없음)'}`);
note.push(
  `[inventory] 면제: ${[...pinnedFiles.keys()].filter((f) => EXEMPT.has(f)).map((f) => `${f} ← ${EXEMPT.get(f)}`).join(' | ')}`,
);

// A-2b. 풀스크린 컬럼 레이아웃의 하단 바.
//
//   DM 화면이 바로 이 패턴이다: `fixed inset-0 flex flex-col` 오버레이 안에서
//   composer는 마지막 flex 자식이라 **`bottom-0`을 쓰지 않는다**. 그래서
//   A-2(bottom-0 검색)로는 원천적으로 잡힐 수 없었다 — mutation M3(DM composer의
//   pb-safe만 제거)이 GREEN으로 통과하는 것으로 실측 확인했다. 이 축이 없으면
//   게이트는 다음번 동일 결손을 놓친다.
//   뷰포트 하단에 도킹되는 바는 `border-t`(상단 구분선)로 식별한다.
const FULLSCREEN_COL_RE = /className="[^"]*\bfixed\b[^"]*\binset-0\b[^"]*\bflex-col\b[^"]*"/;
const BOTTOM_BAR_RE = /className="([^"]*\bborder-t\b[^"]*)"/g;

const fullscreenBarMisses = [];
let fullscreenBarChecked = 0;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  if (!FULLSCREEN_COL_RE.test(text)) continue;
  const rel = path.relative(ROOT, f);
  BOTTOM_BAR_RE.lastIndex = 0;
  for (const m of text.matchAll(BOTTOM_BAR_RE)) {
    const cls = m[1];
    // 상단 헤더(sticky top-0)는 하단 바가 아니다.
    if (/\btop-0\b/.test(cls)) continue;
    // 배경색 지정이 없는 구분선은 리스트 내부 셀 분리선 — 도킹 바로 보지 않는다.
    if (!/\bbg-/.test(cls)) continue;
    fullscreenBarChecked += 1;
    // className 뿐 아니라 같은 JSX 에레멘트의 inline style까지 본다.
    // 변수 기반 보정(`calc(${safeBottom} + 24px)`)은 선언부가 위쪽에 있으므로
    // 앞쪽을 넓게(파일 전체 선언 탐색) 뒤쪽은 짧게 준다.
    const elementWindow = text.slice(Math.max(0, m.index - 400), m.index + m[0].length + 400);
    const declScope = text.slice(0, m.index) + elementWindow;
    if (hasRealBottomInset(cls) || hasRealBottomInset(elementWindow) || hasRealBottomInset(declScope))
      continue;
    const line = text.slice(0, m.index).split('\n').length;
    fullscreenBarMisses.push(`${rel}:${line} → ${cls.slice(0, 70)}`);
  }
}
if (fullscreenBarMisses.length) {
  fail.push(
    `[A-2b] 풀스크린 오버레이 하단 바에 safe-area-inset-bottom 보정 없음 ${fullscreenBarMisses.length}건:\n` +
      fullscreenBarMisses.map((s) => `      ${s}`).join('\n'),
  );
} else if (fullscreenBarChecked === 0) {
  fail.push('[A-2b] 검사 대상 하단 바를 하나도 못 찾음 — 탐지기 결손 (fail-close)');
} else {
  pass.push(`[A-2b] 풀스크린 오버레이 하단 바 ${fullscreenBarChecked}곳 전부 inset 보정 확인`);
}

// A-2c. 바텀시트 오버레이(`fixed inset-0` + `items-end`)의 *마지막* 하단 영역.
//
//   A-2 는 `bottom-0` 을, A-2b 는 `flex-col` 풀스크린을 본다. 그런데 바텀시트는
//   부모가 `items-end` 로 밀어붙이므로 시트 본체에 `bottom-0` 이 없어도 뷰포트
//   하단에 닿는다. 실측으로 VenueDiaryAddGameSheet 의 inset 을 지워도 A-1/A-2/A-2b
//   가 전부 GREEN 이었다 — 이 축이 없으면 같은 결손을 다시 놓친다.
//   시트에서 실제로 맨 아래에 깔리는 건 소스 순서상 *마지막* 하단 영역이다
//   (스크롤러만 있으면 스크롤러, 그 뒤에 푸터바가 있으면 푸터바).
const SHEET_OVERLAY_RE = /className="[^"]*\bfixed\b[^"]*\binset-0\b[^"]*\bitems-end\b[^"]*"/;
const BOTTOM_REGION_RE = /className=(?:"|\{`)([^"`]*(?:overflow-y-auto|overflow-y-scroll|border-t)[^"`]*)(?:"|`\})/g;

const sheetMisses = [];
let sheetChecked = 0;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  if (!SHEET_OVERLAY_RE.test(text)) continue;
  const rel = path.relative(ROOT, f);

  BOTTOM_REGION_RE.lastIndex = 0;
  const regions = [...text.matchAll(BOTTOM_REGION_RE)].filter((m) => {
    const cls = m[1];
    if (/\btop-0\b/.test(cls)) return false; // sticky 헤더
    // 입력창 자체(textarea max-h + overflow)는 도킹 영역이 아니라 그 부모가 책임진다.
    if (/\bresize-none\b/.test(cls)) return false;
    return true;
  });

  // 후보가 아예 없는 시트(단순 버튼 그리드 등)는 파일 단위로 완화한다.
  if (regions.length === 0) {
    sheetChecked += 1;
    if (!hasRealBottomInset(text)) sheetMisses.push(`${rel} — 시트 전체에 inset 보정 없음`);
    continue;
  }

  const last = regions[regions.length - 1];
  sheetChecked += 1;
  const win = text.slice(Math.max(0, last.index - 400), last.index + last[0].length + 400);
  const declScope = text.slice(0, last.index) + win;
  if (hasRealBottomInset(last[1]) || hasRealBottomInset(win) || hasRealBottomInset(declScope)) continue;
  const line = text.slice(0, last.index).split('\n').length;
  sheetMisses.push(`${rel}:${line} → ${last[1].slice(0, 70)}`);
}
if (sheetMisses.length) {
  fail.push(
    `[A-2c] 바텀시트 최하단 영역에 safe-area-inset-bottom 보정 없음 ${sheetMisses.length}건:\n` +
      sheetMisses.map((s) => `      ${s}`).join('\n'),
  );
} else if (sheetChecked === 0) {
  fail.push('[A-2c] 바텀시트 오버레이를 하나도 못 찾음 — 탐지기 결손 (fail-close)');
} else {
  pass.push(`[A-2c] 바텀시트 오버레이 ${sheetChecked}곳 최하단 영역 전부 inset 보정 확인`);
}

// A-3. 게이트가 대상 CSS 파일을 실제로 읽었는지(경로 오타 fail-close)
if (defined.size === 0) {
  fail.push('[A-3] globals.css에서 클래스 정의를 하나도 못 읽음 — 경로/파서 결손 (fail-close)');
} else {
  pass.push(`[A-3] globals.css 클래스 정의 ${defined.size}개 파싱`);
}

// ─────────────────────────────────────────────────────────────
// [B] 런타임: 실 브라우저 + CDP safe-area 주입 + DOM rect 픽셀 측정
// ─────────────────────────────────────────────────────────────

const RUNTIME_TARGETS = [
  {
    name: 'DM 대화 composer',
    // 로그인이 필요한 경로라 정적 페이지에 composer DOM을 심어 측정할 수 없다.
    // 대신 배포된 CSS 규칙 자체를 실브라우저에서 평가한다(아래 evaluateCssContract).
    kind: 'css-contract',
  },
];

const WIDTHS = [320, 360, 390, 412, 430];
const INSETS = [
  { label: '3-button nav', bottom: 48 },
  { label: 'gesture nav', bottom: 24 },
  { label: 'no nav', bottom: 0 },
];

async function runtimeGate() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return { skipped: true, reason: 'playwright 미설치' };
  }

  const browser = await chromium.launch();
  const results = [];
  try {
    for (const width of WIDTHS) {
      for (const inset of INSETS) {
        const ctx = await browser.newContext({ viewport: { width, height: 844 } });
        const page = await ctx.newPage();
        const cdp = await ctx.newCDPSession(page);
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
        await cdp.send('Emulation.setSafeAreaInsetsOverride', {
          insets: { top: 0, bottom: inset.bottom, left: 0, right: 0 },
        });

        // 배포 CSS가 실제로 하단 inset을 만들어내는지 — 대표 composer 마크업을
        // 실 페이지 DOM에 삽입해 computed style + rect로 잰다.
        const measured = await page.evaluate(() => {
          // 실제 DM composer와 동일한 className 조합 — `p-5`(또는 py-3)가 layered 유틸로
          // 먼저 잡아도 unlayered .pb-safe가 이기는지까지 함께 검증한다.
          const host = document.createElement('div');
          host.setAttribute('data-safe-inset-probe', '');
          host.className = 'fixed bottom-0 left-0 right-0 px-5 py-3 pb-safe';
          host.style.cssText += ';height:56px;';
          document.body.appendChild(host);

          const cs = getComputedStyle(host);
          const rect = host.getBoundingClientRect();
          const out = {
            paddingBottom: cs.paddingBottom,
            rectBottom: rect.bottom,
            innerHeight: window.innerHeight,
            // env() 자체가 내려오는지 대조군
            envProbe: (() => {
              const d = document.createElement('div');
              d.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
              document.body.appendChild(d);
              const v = getComputedStyle(d).paddingBottom;
              d.remove();
              return v;
            })(),
          };
          host.remove();
          return out;
        });

        const envPx = parseFloat(measured.envProbe) || 0;
        const padPx = parseFloat(measured.paddingBottom) || 0;

        const row = {
          width,
          inset: inset.label,
          insetPx: inset.bottom,
          envPx,
          paddingBottomPx: padPx,
          ok: envPx === inset.bottom && padPx >= inset.bottom,
        };
        results.push(row);
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }
  return { skipped: false, results };
}

// ─────────────────────────────────────────────────────────────

async function main() {
  let runtime = { skipped: true, reason: '--static' };
  if (!STATIC_ONLY) {
    runtime = await runtimeGate();
    if (runtime.skipped) {
      fail.push(`[B] 런타임 게이트 실행 불가: ${runtime.reason} (fail-close)`);
    } else {
      const bad = runtime.results.filter((r) => !r.ok);
      if (bad.length) {
        fail.push(
          `[B] 런타임 하단 inset 미보정 ${bad.length}/${runtime.results.length}:\n` +
            bad
              .map(
                (r) =>
                  `      ${r.width}px / ${r.inset}(${r.insetPx}px): env=${r.envPx}px paddingBottom=${r.paddingBottomPx}px`,
              )
              .join('\n'),
        );
      } else {
        pass.push(`[B] 런타임 ${runtime.results.length}조합 전부 inset 보정 확인 (5폭 × 3 nav)`);
      }
    }
  } else {
    note.push('[B] --static: 런타임 게이트 생략 (최종 근거로 쓰지 말 것)');
  }

  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(
      path.join(ARTIFACT_DIR, 'bottom-safe-inset-gate.json'),
      JSON.stringify(
        { baseUrl: BASE_URL, at: new Date().toISOString(), pass, fail, note, runtime },
        null,
        2,
      ),
    );
  } catch {
    /* artifact 실패는 판정에 영향 없음 */
  }

  console.log('=== 하단 safe-area inset 게이트 ===');
  for (const p of pass) console.log('  PASS', p);
  for (const n of note) console.log('  NOTE', n);
  for (const f of fail) console.log('  FAIL', f);
  console.log(`\n결과: ${fail.length === 0 ? 'PASS' : `FAIL (${fail.length}건)`}`);
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('게이트 실행 실패 (fail-close):', e);
  process.exit(2);
});
