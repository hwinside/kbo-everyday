#!/usr/bin/env node
/**
 * UI 스모크: 경기 헤더 스코어보드 두 자리 점수 레이아웃 회귀 (PR #820)
 *
 * 삼순 리뷰 계측 기준 그대로: score row clientWidth/scrollWidth,
 * away 그룹 boundingRect.x, home 그룹 boundingRect.right 를 실렌더 DOM에서 측정.
 *
 * 검증 기준 (뷰포트 W, row padding P=16):
 *   1. row scrollWidth <= clientWidth        (가로 overflow 0)
 *   2. away.x >= P - EPS, home.right <= W - P + EPS  (px-4 패딩 안 수납)
 *   3. 팀명 span 1줄 유지 (height < 1.5 line)
 *
 * 케이스: 1:0(한 자리) / 14:4 / 14:10(양팀 두 자리 최악) / 100:99(세 자리 방어)
 * 뷰포트: 320 / 360 / 390
 *
 * 사용법:
 *   npm run dev  (별도 셸에서 로컬 서버)
 *   node scripts/qa/ui-smoke-score-layout.mjs [--base-url=http://localhost:3000]
 */
import playwright from "playwright";

const { chromium } = playwright;
const BASE_URL =
  process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] ??
  "http://localhost:3000";

const WIDTHS = [320, 360, 390];
const CASES = [
  { away: 1, home: 0, label: "1:0 (한 자리)" },
  { away: 14, home: 4, label: "14:4 (한쪽 두 자리)" },
  { away: 14, home: 10, label: "14:10 (양팀 두 자리 최악)" },
  { away: 100, home: 99, label: "100:99 (세 자리 방어)" },
];
const PAD = 16; // px-4
const EPS = 0.5; // subpixel 허용 오차

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

async function measure(page, rootSel, viewportW) {
  return page.evaluate(
    ([sel, W]) => {
      const root = document.querySelector(sel);
      const row = root.querySelector('[data-testid="score-row"]');
      const away = root.querySelector('[data-testid="score-away"]');
      const home = root.querySelector('[data-testid="score-home"]');
      const names = [...root.querySelectorAll("span.whitespace-nowrap")].filter(
        (s) => s.closest('[data-testid="score-away"],[data-testid="score-home"]'),
      );
      const a = away.getBoundingClientRect();
      const h = home.getBoundingClientRect();
      return {
        clientWidth: row.clientWidth,
        scrollWidth: row.scrollWidth,
        awayX: a.x,
        homeRight: h.right,
        viewport: W,
        nameHeights: names.map((n) => {
          const r = n.getBoundingClientRect();
          const lh = parseFloat(getComputedStyle(n).lineHeight) || 28;
          return { h: r.height, lh };
        }),
      };
    },
    [rootSel, viewportW],
  );
}

async function main() {
  const browser = await chromium.launch();
  try {
    for (const width of WIDTHS) {
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        deviceScaleFactor: 2,
      });
      for (const c of CASES) {
        await page.goto(`${BASE_URL}/qa/score-layout?away=${c.away}&home=${c.home}`, {
          waitUntil: "networkidle",
        });
        for (const comp of ["scorebar", "nonlive"]) {
          const m = await measure(page, `[data-qa="${comp}"]`, width);
          rows.push({ width, case: c.label, comp, ...m });
          const tag = `${width}px ${comp} ${c.label}`;
          check(`${tag} overflow 없음`, m.scrollWidth <= m.clientWidth,
            `scrollWidth=${m.scrollWidth} > clientWidth=${m.clientWidth}`);
          check(`${tag} away 좌측 패딩 안`, m.awayX >= PAD - EPS, `away.x=${m.awayX.toFixed(1)}`);
          check(`${tag} home 우측 패딩 안`, m.homeRight <= width - PAD + EPS,
            `home.right=${m.homeRight.toFixed(1)} (limit ${width - PAD})`);
          for (const [i, n] of m.nameHeights.entries()) {
            check(`${tag} 팀명#${i} 1줄`, n.h < n.lh * 1.5, `height=${n.h} lineHeight=${n.lh}`);
          }
        }
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }

  console.log("\n| width | comp | case | clientW | scrollW | away.x | home.right |");
  console.log("|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(
      `| ${r.width} | ${r.comp} | ${r.case} | ${r.clientWidth} | ${r.scrollWidth} | ${r.awayX.toFixed(1)} | ${r.homeRight.toFixed(1)} |`,
    );
  }
  console.log(`\n✅ ${passCount} passed / ❌ ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
