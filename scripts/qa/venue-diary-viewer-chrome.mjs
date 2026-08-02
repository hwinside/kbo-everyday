#!/usr/bin/env node
/**
 * 직관 다이어리 뷰어(전체창) 상·하단 크롬 회귀 — 실제 컴포넌트를 390×844 Chromium 에 마운트.
 *
 * 2026-08-02 하린아빠 실기기 리포트 3건:
 *   ① iOS: 좌측 X · 우측 … 둘 다 눌리지 않아 화면에 갇힘
 *   ② Android: 하단 텍스트가 기기 탭바(제스처 바)에 가림
 *   ③ '이 경기 사진첩 열기' 눌러도 아무 반응 없음(뷰어 자체가 사진첩이므로 메뉴 제거)
 *
 * ①의 기전은 이미 이 저장소가 겪은 사고다(#795 blocker / #843). iOS 네이티브 상태바는
 * z-index 로 덮을 수 없고, 원격 로드 WKWebView 에서 env(safe-area-inset-top) 이 0 으로
 * 깨지는 기기가 있다. 그래서 VenueStoryViewer 는 isIosNativeRuntime() 일 때 상단 인셋을
 * max(env(...), 44px) 로 보정한다. VenueDiaryViewer 는 그 보정 없이 top-6(24px) 고정이라
 * 버튼이 상태바 밴드(0~59px) 안에 들어가 터치가 상태바에 먹힌다.
 *
 * 이 회귀는 "상태바 밴드 침범 여부"를 기하로 잠근다(safe-area=0 인 최악 조건에서 측정).
 * 실기기 터치 인터셉트 자체는 브라우저로 재현할 수 없으므로, 침범하지 않음을 계약으로 삼는다.
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import playwright from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRE_BROWSER = process.env.VENUE_DIARY_VIEWER_REQUIRE_BROWSER === "1";
let chromiumPath = null;
try {
  chromiumPath = playwright.chromium.executablePath();
} catch {
  chromiumPath = null;
}
if (!chromiumPath || !existsSync(chromiumPath)) {
  const detail = chromiumPath ? `not found at ${chromiumPath}` : "executablePath unavailable";
  if (REQUIRE_BROWSER) {
    console.error(`FAIL: playwright chromium 사용 불가(fail-closed) — ${detail}`);
    process.exit(1);
  }
  console.log(`SKIP: playwright chromium 사용 불가 — ${detail}`);
  process.exit(0);
}

const ROOT = process.cwd();
const QA_TMP_ROOT = resolve(ROOT, "../tmp");
mkdirSync(QA_TMP_ROOT, { recursive: true });
const GEN = mkdtempSync(resolve(QA_TMP_ROOT, "qa-venue-diary-viewer-"));
mkdirSync(resolve(ROOT, "tmp/qa-screenshots"), { recursive: true });

// iPhone 15 Pro 세로 기준 상태바 밴드(Dynamic Island 포함 59px).
const STATUS_BAR_BAND = 59;
// Android 3버튼/제스처 내비게이션 바 실측 대역(하린아빠 A17 스크린샷 기준 보수값).
const ANDROID_NAV_BAR = 48;

let pass = 0;
const fails = [];
const check = (label, cond, extra = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fails.push(label);
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

// ── 결함 주입(RED 증명용) ────────────────────────────────────────────────────
const MUTATE_TOP = process.env.VENUE_DIARY_VIEWER_MUTATE_TOP === "1";
const MUTATE_BOTTOM = process.env.VENUE_DIARY_VIEWER_MUTATE_BOTTOM === "1";
const MUTATE_MENU = process.env.VENUE_DIARY_VIEWER_MUTATE_MENU === "1";

const viewerPath = resolve(ROOT, "src/components/my/VenueDiaryViewer.tsx");
let viewerSource = readFileSync(viewerPath, "utf8");

if (MUTATE_TOP) {
  // 사고 당시 마크업으로 되돌린다(상단 인셋 보정 없음 + top-6 고정).
  const before = viewerSource;
  viewerSource = viewerSource
    .replace(/style=\{\{ top: `calc\(\$\{safeTop\}[^`]*` \}\}/g, 'style={{ top: "24px" }}')
    .replace(/style=\{\{ top: `calc\(\$\{safeTop\}[^`]*`, [^}]*\}\}/g, 'style={{ top: "24px" }}');
  if (viewerSource === before) throw new Error("MUTATE_TOP: 주입 지점을 찾지 못함");
}
if (MUTATE_BOTTOM) {
  const before = viewerSource;
  viewerSource = viewerSource.replace(
    /style=\{\{ paddingBottom: `calc\(\$\{safeBottom\} \+ 24px\)` \}\}/,
    'style={{ paddingBottom: "24px" }}',
  );
  if (viewerSource === before) throw new Error("MUTATE_BOTTOM: 주입 지점을 찾지 못함");
}
if (MUTATE_MENU) {
  // 제거한 dead button 을 다시 넣어 메뉴 무반응 회귀를 주입한다.
  const before = viewerSource;
  viewerSource = viewerSource.replace(
    /            <button\n              onClick=\{handleDelete\}/,
    `            <button
              onClick={() => setMenuOpen(false)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold text-text-secondary"
            >
              이 경기 사진첩 열기
            </button>
            <button
              onClick={handleDelete}`,
  );
  if (viewerSource === before) throw new Error("MUTATE_MENU: 주입 지점을 찾지 못함");
}

const viewerEntry = resolve(GEN, "VenueDiaryViewer.entry.tsx");
writeFileSync(viewerEntry, viewerSource);

// ── 하네스 엔트리 ────────────────────────────────────────────────────────────
// safe-area 인셋이 0 으로 깨진 최악 조건(iOS 원격로드 WKWebView 실사고 조건)을 그대로 둔다.
// Chromium 은 env(safe-area-inset-*) 를 0 으로 계산하므로 별도 조작 없이 그 조건이 된다.
const harness = `
import React from "react";
import { createRoot } from "react-dom/client";
import VenueDiaryViewer from ${JSON.stringify(viewerEntry)};

const MEDIA = [
  {
    id: 101,
    gameId: "20260725WOHT0",
    mediaType: "image",
    mediaUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    thumbUrl: null,
    caption: "1루 응원석에서 본 9회말 역전 순간. 정말 오랜만에 소리 질렀다.",
    venueVerified: true,
    stadiumName: "고척",
    createdAt: new Date().toISOString(),
    comments: [],
  },
  {
    id: 102,
    gameId: "20260725WOHT0",
    mediaType: "image",
    mediaUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    thumbUrl: null,
    caption: null,
    venueVerified: false,
    stadiumName: "고척",
    createdAt: new Date().toISOString(),
    comments: [],
  },
];

const origFetch = window.fetch;
window.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/api/me/venue-diary/media")) {
    return new Response(JSON.stringify({ gameId: "20260725WOHT0", media: MEDIA }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return origFetch(url, init);
};

function App() {
  const platform = new URLSearchParams(window.location.search).get("platform") ?? "ios";
  window.Capacitor = {
    isNativePlatform: () => platform !== "web",
    getPlatform: () => platform,
  };
  return (
    <VenueDiaryViewer
      gameId="20260725WOHT0"
      header={{ matchLabel: "키움 5 : 3 KT", dateLabel: "2026.07.25 · 고척", result: "W" }}
      isOpen
      onClose={() => { window.__closed = (window.__closed ?? 0) + 1; }}
      onChanged={() => {}}
    />
  );
}
createRoot(document.getElementById("root")).render(<App />);
`;
const harnessEntry = resolve(GEN, "harness.tsx");
writeFileSync(harnessEntry, harness);

const bundlePath = resolve(GEN, "bundle.js");
await build({
  entryPoints: [harnessEntry],
  bundle: true,
  outfile: bundlePath,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".ts": "ts", ".tsx": "tsx" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.NEXT_PUBLIC_SUPABASE_URL": '"https://qa.invalid"',
    "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": '"qa-anon-key"',
  },
  // 번들에 process shim 이 없으면 페이지가 통째로 죽어 "빈 화면인데 통과"가 된다.
  banner: { js: "globalThis.process=globalThis.process||{env:{NODE_ENV:'production'}};" },
  absWorkingDir: ROOT,
  // 생성 엔트리가 repo 밖(tmp)에 있어 기본 node 해석으로는 react 등을 못 찾는다.
  nodePaths: [resolve(ROOT, "node_modules")],
  tsconfig: resolve(ROOT, "tsconfig.json"),
  logLevel: "silent",
});

const cssPath = resolve(ROOT, "src/styles/globals.css");
const css = (
  await postcss([tailwind()]).process(readFileSync(cssPath, "utf8"), { from: cssPath })
).css;

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>${css}</style><style>html,body{margin:0;background:#0A0A0B}</style>
</head><body class="dark"><div id="root"></div><script src="/bundle.js"></script></body></html>`;

const bundleJs = readFileSync(bundlePath, "utf8");
const server = createServer((req, res) => {
  if (req.url === "/bundle.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(bundleJs);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await playwright.chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/?platform=ios`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const closeVisible = await page.locator('[aria-label="닫기"]').count();
  if (closeVisible === 0) {
    throw new Error(`iOS 하네스 렌더 실패: ${consoleErrors.join(" | ")} / body=${(await page.locator("body").innerText()).slice(0, 300)}`);
  }

  // 하네스 유효성 — 페이지가 실제로 살아있고 미디어가 그려졌는가.
  const alive = await page.evaluate(() => ({
    imgs: document.querySelectorAll("img").length,
    bodyLen: document.body.innerText.length,
  }));
  check("[하네스] 뷰어가 실제로 렌더됨(빈 화면 아님)", alive.imgs > 0 && alive.bodyLen > 0,
    JSON.stringify(alive));
  check("[하네스] 페이지 런타임 에러 0", consoleErrors.length === 0, consoleErrors.join(" | "));

  // ── ① 상단 크롬: 상태바 밴드 침범 금지 ──────────────────────────────────
  const topGeom = await page.evaluate(() => {
    const q = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    };
    return { close: q('[aria-label="닫기"]'), more: q('[aria-label="더보기"]') };
  });
  check("[①-iOS] 닫기 버튼이 상태바 밴드(59px) 아래에서 시작",
    topGeom.close != null && topGeom.close.top >= STATUS_BAR_BAND,
    `close.top=${topGeom.close?.top} (필요 ≥${STATUS_BAR_BAND})`);
  check("[①-iOS] 더보기 버튼이 상태바 밴드(59px) 아래에서 시작",
    topGeom.more != null && topGeom.more.top >= STATUS_BAR_BAND,
    `more.top=${topGeom.more?.top} (필요 ≥${STATUS_BAR_BAND})`);
  check("[①-접근성] 닫기 버튼 44px 터치 타겟",
    topGeom.close != null && topGeom.close.w >= 44 && topGeom.close.h >= 44,
    `close=${topGeom.close?.w}x${topGeom.close?.h}`);
  check("[①-접근성] 더보기 버튼 44px 터치 타겟",
    topGeom.more != null && topGeom.more.w >= 44 && topGeom.more.h >= 44,
    `more=${topGeom.more?.w}x${topGeom.more?.h}`);

  // 실제로 눌리는가(히트테스트) — 좌표 중심의 최상위 엘리먼트가 그 버튼인가.
  const hit = await page.evaluate(() => {
    const at = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el.contains(top) || top === el;
    };
    return { close: at('[aria-label="닫기"]'), more: at('[aria-label="더보기"]') };
  });
  check("[①] 닫기 버튼이 히트테스트 최상위(가려지지 않음)", hit.close === true);
  check("[①] 더보기 버튼이 히트테스트 최상위(가려지지 않음)", hit.more === true);

  await page.click('[aria-label="닫기"]');
  const closed = await page.evaluate(() => window.__closed ?? 0);
  check("[①] 닫기 클릭이 onClose 를 실제로 호출", closed === 1, `closed=${closed}`);

  // ── ③ no-op 메뉴 제거 ────────────────────────────────────────────────────
  await page.click('[aria-label="더보기"]');
  const menuState = await page.evaluate(() => ({
    hasDeadAlbumAction: document.body.innerText.includes("이 경기 사진첩 열기"),
    hasDeleteAction: document.body.innerText.includes("이 사진 삭제"),
  }));
  check("[③] 무반응 '이 경기 사진첩 열기' 메뉴가 제거됨", menuState.hasDeadAlbumAction === false);
  check("[③] 실제 동작하는 미디어 삭제 메뉴는 유지", menuState.hasDeleteAction === true);

  // ── ② 하단 시트: 내비게이션 바에 가리지 않음 ────────────────────────────
  await page.goto(`http://127.0.0.1:${port}/?platform=android`, { waitUntil: "networkidle" });
  await page.waitForSelector('[aria-label="닫기"]', { timeout: 10000 });
  const bottomGeom = await page.evaluate(() => {
    // 캡션 텍스트를 품은 하단 시트.
    const sheets = [...document.querySelectorAll("div")].filter((d) => {
      const cs = getComputedStyle(d);
      return cs.overflowY === "auto" && d.innerText.includes("1루 응원석");
    });
    const sheet = sheets[sheets.length - 1];
    if (!sheet) return null;
    const r = sheet.getBoundingClientRect();
    const cs = getComputedStyle(sheet);
    // 시트 안 마지막 텍스트 노드의 실제 바닥.
    const inner = [...sheet.querySelectorAll("p,div,b")].filter((e) => e.innerText.trim());
    const lastBottom = inner.length
      ? Math.max(...inner.map((e) => e.getBoundingClientRect().bottom))
      : r.bottom;
    return {
      paddingBottom: parseFloat(cs.paddingBottom),
      sheetBottom: +r.bottom.toFixed(1),
      lastTextBottom: +lastBottom.toFixed(1),
      viewportH: window.innerHeight,
    };
  });
  check("[②] 하단 시트를 찾음", bottomGeom != null);
  check("[②-Android] 하단 패딩이 내비게이션 바(48px) 이상 확보",
    bottomGeom != null && bottomGeom.paddingBottom >= ANDROID_NAV_BAR,
    `paddingBottom=${bottomGeom?.paddingBottom} (필요 ≥${ANDROID_NAV_BAR})`);
  check("[②] 마지막 텍스트 바닥이 내비바 대역을 침범하지 않음",
    bottomGeom != null
      && bottomGeom.lastTextBottom <= bottomGeom.viewportH - ANDROID_NAV_BAR,
    `lastTextBottom=${bottomGeom?.lastTextBottom} limit=${bottomGeom ? bottomGeom.viewportH - ANDROID_NAV_BAR : "?"}`);

  await page.screenshot({ path: resolve(ROOT, "tmp/qa-screenshots/venue-diary-viewer-android-390.png") });

  // 웹/PWA에 네이티브 48px 폴백을 강제하지 않는지(#843 회귀 방지).
  await page.goto(`http://127.0.0.1:${port}/?platform=web`, { waitUntil: "networkidle" });
  await page.waitForSelector('[aria-label="닫기"]', { timeout: 10000 });
  const webPaddingBottom = await page.evaluate(() => {
    const sheet = [...document.querySelectorAll("div")].find((d) => {
      const cs = getComputedStyle(d);
      return cs.overflowY === "auto" && d.innerText.includes("1루 응원석");
    });
    return sheet ? parseFloat(getComputedStyle(sheet).paddingBottom) : null;
  });
  check("[②-web] 웹/PWA는 기존 24px 하단 여백 유지",
    webPaddingBottom === 24,
    `paddingBottom=${webPaddingBottom}`);
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}

if (fails.length === 0) {
  console.log(`\nPASS — ${pass}/${pass}`);
  process.exit(0);
}
console.log(`\nFAIL ${fails.length} / exit 1`);
process.exit(1);
