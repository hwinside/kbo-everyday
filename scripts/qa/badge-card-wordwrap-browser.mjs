#!/usr/bin/env node
/**
 * 배지 카드 배지명 줄바꿈 — 실제 Chromium 렌더 게이트 (320/360/375/390px).
 *
 * 배경(삼순 post-merge NO-GO 2026-08-03, Production 실측):
 *   320px: `크보팬 전속가수` → `크보/팬`, `전속/가수`, `파운더` → `파운/더`
 *   360·375px: `전속가/수`
 *   390px: 어절 보존
 * 그런데 `qa:exclusive-badges` 와 full prebuild 는 GREEN 이었다.
 *
 * false-green 의 원인은 소스 문자열 검사였다:
 *   - `wordBreak: "keep-all"` 이 소스에 있는지만 봤다. 같은 style 에 있는
 *     `overflowWrap: "break-word"` 가 폭이 모자랄 때 keep-all 을 무력화한다는 사실을
 *     문자열 검사로는 알 수 없다.
 *   - 어절 길이 가드가 max-w-lg(512px) 만 가정해 "어절당 8자 안전" 으로 계산했다.
 *     실제 모바일 4열 카드의 텍스트 폭은 320px 에서 ~37px(한글 3.7자)다.
 *
 * 그래서 이 게이트는 문자열이 아니라 **렌더된 line box** 를 본다.
 * Range.getClientRects() 로 각 어절의 조각이 몇 개의 line box 에 걸쳐 있는지 세고,
 * 한 어절이 2줄로 쪼개지면 FAIL 한다. 카드 밖으로 넘치는 것도 함께 본다.
 *
 * 실행: npm run qa:badge-card-wordwrap
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import playwright from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REQUIRE_BROWSER = process.env.BADGE_WORDWRAP_REQUIRE_BROWSER === "1";
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
const GEN = mkdtempSync(resolve(tmpdir(), "badge-wordwrap-"));
mkdirSync(resolve(ROOT, "tmp/qa-screenshots"), { recursive: true });

// 하린아빠 실사용 기기 + 최소 지원 폭. 320 은 iPhone SE(1st)/갤럭시 폴드 접힘 기준.
const WIDTHS = [320, 360, 375, 390];

let pass = 0;
const fails = [];
const measured = [];
const ok = (label, cond, extra = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fails.push(label);
    console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

// ── 결함 주입(RED 증명) ─────────────────────────────────────────────────────
// `--mutate` 는 사고 당시 상태(고정 10px)로 되돌린다. 이 게이트가 실제로 회귀를 잡는지
// 증명하는 용도이며, RED 가 나와야 정상이다.
//
// ⚠️ mutation 대상을 세 번 옮겼다. 기록을 남긴다:
//   1차 overflowWrap → RED 미발생(단독 효과 없음)
//   2차 fontSize clamp → 3열 반응형을 도입하자 역시 RED 미발생
//   3차 grid-cols → 현재 실효 수정. 4열 전환을 좁은 폭으로 되돌리면 칸 폭이 모자라
//   4자 어절(`회장남편`)이 못 들어간다.
// 게이트는 "실제로 사고를 막고 있는 변경" 을 지켜야 하므로 grid-cols 를 대상으로 한다.
//
// 삼순 NO-GO(2026-08-03) 반영: 분절/overflow 만 보면 **읽을 수 없는 폰트도 GREEN** 이다.
// 실제로 `clamp(1px, 1cqw, 2px)` 를 주입해도 14/14 PASS 했다. 그래서 아래 tiny-font
// mutation(BADGE_WORDWRAP_MUTATE=font)과 computed font-size 계약을 함께 넣는다.
// BADGE_WORDWRAP_MUTATE=1|grid  → 반응형 열 수를 사고 당시(항상 4열)로 되돌린다
// BADGE_WORDWRAP_MUTATE=font     → 배지명을 읽을 수 없는 크기로 줄인다
const MUTATE = process.env.BADGE_WORDWRAP_MUTATE ?? "";
const tabPath = resolve(ROOT, "src/components/profile/BadgesTab.tsx");
let tabSource = readFileSync(tabPath, "utf8");
if (MUTATE === "1" || MUTATE === "grid") {
  const before = tabSource;
  tabSource = tabSource.replace(
    /grid grid-cols-3 min-\[\d+px\]:grid-cols-4 gap-3/,
    "grid grid-cols-4 gap-3",
  );
  if (tabSource === before) {
    console.error("FAIL: mutation 대상(grid-cols 반응형)을 찾지 못했습니다");
    process.exit(1);
  }
} else if (MUTATE === "font") {
  const before = tabSource;
  tabSource = tabSource.replace(/fontSize: "10px",/, 'fontSize: "clamp(1px, 1cqw, 2px)",');
  if (tabSource === before) {
    console.error("FAIL: mutation 대상(배지명 fontSize)을 찾지 못했습니다");
    process.exit(1);
  }
} else if (MUTATE) {
  console.error(`FAIL: 알 수 없는 mutation 종류 "${MUTATE}" (grid|font)`);
  process.exit(1);
}
const tabEntry = resolve(GEN, "BadgesTab.entry.tsx");
writeFileSync(tabEntry, tabSource);

// 실제 배지 카탈로그에서 한정 배지 + 최장 어절 배지를 뽑아 쓴다(하드코딩 금지).
const harness = `
import React from "react";
import { createRoot } from "react-dom/client";
import BadgesTab from ${JSON.stringify(tabEntry)};
import { BADGES, BADGE_MAP, EXCLUSIVE_BADGE_IDS } from ${JSON.stringify(resolve(ROOT, "src/lib/constants/badges.ts"))};

// 한정 배지는 보유해야 렌더되므로 전부 보유 상태로 둔다.
const owned = new Set([...EXCLUSIVE_BADGE_IDS, "founder"]);
const badges = [...owned].map((id) => ({ badge_id: id, earned_at: new Date().toISOString() }));

window.__badgeNames = BADGES.filter((b) => !EXCLUSIVE_BADGE_IDS.has(b.id) || owned.has(b.id))
  .map((b) => b.name);

function App() {
  return (
    <div className="mx-auto max-w-lg bg-bg-primary min-h-screen">
      <BadgesTab badges={badges} earnedBadgeIds={owned} onSelectBadge={() => {}} />
    </div>
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
  define: { "process.env.NODE_ENV": '"production"' },
  banner: { js: "globalThis.process=globalThis.process||{env:{NODE_ENV:'production'}};" },
  absWorkingDir: ROOT,
  nodePaths: [resolve(ROOT, "node_modules")],
  tsconfig: resolve(ROOT, "tsconfig.json"),
  logLevel: "silent",
});

const cssPath = resolve(ROOT, "src/styles/globals.css");
const css = (
  await postcss([tailwind()]).process(readFileSync(cssPath, "utf8"), { from: cssPath })
).css;

// ⚠️ body 에 앱과 같은 font-family 를 명시해야 한다.
// 처음엔 이걸 빼먹어 기본 serif 로 렌더됐고, 그 폰트가 더 좁아서
// 320px 텍스트 폭 30.5px 에 `파운더`(3자)가 간슬히 한 줄에 들어갔다.
// 그래서 Production 에서는 `파운/더` 로 깨지는데 게이트는 GREEN 이었다(삼순 실측 대조로 발견).
// 실제 앱은 globals.css 의 --font-sans 를 body 에 적용한다.
const html = `<!doctype html><html lang="ko" class="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style>
<style>html,body{margin:0;background:#0A0A0B;
  font-family:"Montserrat","Noto Sans KR",-apple-system,BlinkMacSystemFont,system-ui,Roboto,sans-serif;}
</style>
</head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;

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
  for (const width of WIDTHS) {
    console.log(`\n[${width}px]`);
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".grid", { timeout: 10000 });

    if (width === WIDTHS[0]) {
      const names = await page.evaluate(() => window.__badgeNames ?? []);
      ok("[하네스] 배지 카탈로그가 실제로 렌더됨", names.length > 0, `names=${names.length}`);
      ok("[하네스] 페이지 런타임 에러 0", errors.length === 0, errors.join(" | "));
    }

    // 각 배지명의 어절이 한 line box 안에 남아 있는지 — 렌더 결과로 판정.
    const broken = await page.evaluate(() => {
      const out = [];
      // 배지명 <p> 는 카드(div) 안 마지막 p
      const cards = [...document.querySelectorAll(".grid > div")];
      for (const card of cards) {
        const p = card.querySelector("p");
        if (!p) continue;
        const text = (p.textContent ?? "").trim();
        if (!text) continue;
        const node = p.firstChild;
        if (!node || node.nodeType !== 3) continue;

        // 어절별로 Range 를 만들어 line box 개수를 센다.
        let cursor = 0;
        const badWords = [];
        for (const word of text.split(/\s+/)) {
          const start = text.indexOf(word, cursor);
          if (start < 0) continue;
          cursor = start + word.length;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + word.length);
          const rects = [...range.getClientRects()];
          // 서로 다른 top 값 = 다른 line box
          const tops = new Set(rects.map((r) => Math.round(r.top)));
          if (tops.size > 1) badWords.push(word);
        }

        // 카드 밖으로 넘쳤는지
        const pr = p.getBoundingClientRect();
        const cr = card.getBoundingClientRect();
        const overflow = pr.right > cr.right + 0.5 || pr.left < cr.left - 0.5;

        if (badWords.length || overflow) {
          out.push({ text, badWords, overflow, textWidth: +pr.width.toFixed(1) });
        }
      }
      return out;
    });

    ok(
      `${width}px: 모든 배지명이 어절 중간에서 쪼개지지 않음`,
      broken.filter((b) => b.badWords.length).length === 0,
      broken.filter((b) => b.badWords.length)
        .map((b) => `"${b.text}"→[${b.badWords.join(",")}]`).join(" "),
    );
    ok(
      `${width}px: 배지명이 카드 밖으로 넘치지 않음`,
      broken.filter((b) => b.overflow).length === 0,
      broken.filter((b) => b.overflow).map((b) => `"${b.text}"`).join(" "),
    );

    // ── 폰트 독립 안전막 ─────────────────────────────────────
    // line box 측정만 사용하면 실행 환경의 한글 폰트가 좀을 때 간슬하게 통과해버린다.
    // 실제로 320px 텍스트 폭 30.5px 에서 `파운더`(3자)가 가까스로 한 줄에 들어가
    // Production 사고(`파운/더`)를 놓쳤다. 그래서 "가장 긴 어절이 칸 폭에
    // 여유를 두고 들어가는가" 를 폭 숫자로 직접 본다.
    // 한글 1자 ≈ font-size 이므로, 최장 어절 길이 × fontSize 가 칸 폭 이하여야 한다.
    const tight = await page.evaluate(() => {
      const out = [];
      for (const card of [...document.querySelectorAll(".grid > div")]) {
        const p = card.querySelector("p");
        if (!p) continue;
        const text = (p.textContent ?? "").trim();
        if (!text) continue;
        const avail = p.getBoundingClientRect().width;
        const fontPx = parseFloat(getComputedStyle(p).fontSize);
        // 한글만 세고 ASCII 는 절반 폭으로 본다(Lv.1 같은 꼬리 보정).
        const widthOf = (w) => [...w].reduce(
          (sum, ch) => sum + (/[\u3131-\uD79D]/.test(ch) ? fontPx : fontPx * 0.55), 0);
        const longest = Math.max(...text.split(/\s+/).map(widthOf));
        if (longest > avail + 0.5) {
          out.push({ text, need: +longest.toFixed(1), avail: +avail.toFixed(1) });
        }
      }
      return out;
    });
    ok(
      `${width}px: 최장 어절이 칸 폭 안에 들어감(폰트 독립 계산)`,
      tight.length === 0,
      tight.map((t) => `"${t.text}" need=${t.need}>avail=${t.avail}`).join(" "),
    );

    // ── 가독성(computed font-size) 계약 ─────────────────────────
    // 삼순 NO-GO 반영: 분절/overflow 만 보면 읽을 수 없는 폰트도 GREEN 이다.
    // 실제 계측값으로 최소 크기와 "폭이 늘어도 작아지지 않음" 을 강제한다.
    const MIN_FONT_PX = 10;
    const fontPx = await page.evaluate(() => {
      const sizes = [];
      for (const card of [...document.querySelectorAll(".grid > div")]) {
        const p = card.querySelector("p");
        if (!p || !(p.textContent ?? "").trim()) continue;
        sizes.push(parseFloat(getComputedStyle(p).fontSize));
      }
      return sizes;
    });
    ok(
      `${width}px: 배지명 computed font-size >= ${MIN_FONT_PX}px`,
      fontPx.length > 0 && Math.min(...fontPx) >= MIN_FONT_PX - 0.01,
      `min=${fontPx.length ? Math.min(...fontPx) : "n/a"}px`,
    );
    measured.push({ width, fontPx: fontPx.length ? Math.min(...fontPx) : 0 });

    // 가로 스크롤 유발 금지
    const hOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    ok(`${width}px: 가로 overflow 0`, hOverflow === false);

    await page.screenshot({
      path: resolve(ROOT, `tmp/qa-screenshots/badge-card-${width}.png`),
      fullPage: true,
    });
    await page.close();
  }
  // 뷰포트가 커질 때 글자가 작아지면 안 된다(반응형 축소 회귀 방지).
  for (let i = 1; i < measured.length; i += 1) {
    const prev = measured[i - 1];
    const cur = measured[i];
    ok(
      `${prev.width}px → ${cur.width}px: 배지명이 작아지지 않음`,
      cur.fontPx >= prev.fontPx - 0.01,
      `${prev.fontPx}px → ${cur.fontPx}px`,
    );
  }
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}

console.log(fails.length === 0 ? `\nPASS — ${pass}/${pass}` : `\nFAIL ${fails.length} / exit 1`);
process.exit(fails.length === 0 ? 0 : 1);
