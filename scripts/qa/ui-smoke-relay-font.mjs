#!/usr/bin/env node
/**
 * UI 스모크: 실시간 문자중계 글자 크기/레이아웃 회귀 (중계 글자 확대 PR)
 *
 * 삼순 리뷰 요구 그대로: 320/360/390px 뷰포트에서 현재/이전 이닝의
 * RelayPlayLine 본문(14px)·보조(12px) 폰트와 가로 overflow를 실렌더 DOM에서 측정.
 *
 * 검증 기준:
 *   1. 본문(data-qa=relay-body) computed font-size == 14px
 *   2. 보조(data-qa=relay-aux)  computed font-size == 12px
 *   3. 중계 컨테이너(data-qa=relay-root) scrollWidth <= clientWidth (가로 overflow 0)
 *   4. 각 플레이 라인 scrollWidth <= clientWidth (긴 결과문도 세로 줄바꿈, 가로 넘침 0)
 *
 * 뷰포트: 320 / 360 / 390
 *
 * 사용법:
 *   npm run dev  (별도 셸에서 로컬 서버)
 *   node scripts/qa/ui-smoke-relay-font.mjs [--base-url=http://localhost:3000]
 */
import playwright from "playwright";

const { chromium } = playwright;
const BASE_URL =
  process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] ??
  "http://localhost:3000";

const WIDTHS = [320, 360, 390];
const BODY_PX = 14;
const AUX_PX = 12;
const EPS = 0.5;

let passCount = 0;
let failCount = 0;
const rows = [];

function check(name, cond, detail) {
  if (cond) {
    passCount++;
  } else {
    failCount++;
    console.log(`  ❌  ${name}  ${detail ?? ""}`);
  }
}

async function measure(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-qa="relay-root"]');
    const bodies = [...document.querySelectorAll('[data-qa="relay-body"]')];
    const auxes = [...document.querySelectorAll('[data-qa="relay-aux"]')];
    const lines = [...document.querySelectorAll('[data-qa="relay-plays"] > *')];
    const fs = (el) => parseFloat(getComputedStyle(el).fontSize);
    return {
      rootClientWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
      bodySizes: bodies.map(fs),
      auxSizes: auxes.map(fs),
      lineOverflow: lines.map((l) => ({ c: l.clientWidth, s: l.scrollWidth })),
      bodyCount: bodies.length,
      auxCount: auxes.length,
    };
  });
}

async function main() {
  const browser = await chromium.launch();
  try {
    for (const width of WIDTHS) {
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        deviceScaleFactor: 2,
      });
      await page.goto(`${BASE_URL}/qa/relay-font`, { waitUntil: "networkidle" });
      const m = await measure(page);
      rows.push({ width, ...m });
      const tag = `${width}px`;

      check(`${tag} 본문 존재`, m.bodyCount > 0, `bodyCount=${m.bodyCount}`);
      check(`${tag} 보조 존재`, m.auxCount > 0, `auxCount=${m.auxCount}`);
      for (const [i, s] of m.bodySizes.entries()) {
        check(`${tag} 본문#${i} 14px`, Math.abs(s - BODY_PX) <= EPS, `font-size=${s}`);
      }
      for (const [i, s] of m.auxSizes.entries()) {
        check(`${tag} 보조#${i} 12px`, Math.abs(s - AUX_PX) <= EPS, `font-size=${s}`);
      }
      check(`${tag} 컨테이너 overflow 없음`, m.rootScrollWidth <= m.rootClientWidth + EPS,
        `scrollWidth=${m.rootScrollWidth} > clientWidth=${m.rootClientWidth}`);
      for (const [i, l] of m.lineOverflow.entries()) {
        check(`${tag} 플레이#${i} 가로 overflow 없음`, l.s <= l.c + EPS,
          `scrollWidth=${l.s} > clientWidth=${l.c}`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }

  console.log("\n| width | body px | aux px | rootClientW | rootScrollW |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) {
    console.log(
      `| ${r.width} | ${[...new Set(r.bodySizes)].join(",")} | ${[...new Set(r.auxSizes)].join(",")} | ${r.rootClientWidth} | ${r.rootScrollWidth} |`,
    );
  }
  console.log(`\n✅ ${passCount} passed / ❌ ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
