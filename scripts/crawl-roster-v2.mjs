#!/usr/bin/env node
/**
 * KBO 로스터 크롤링 v2 - 기록 페이지(HitterBasic + PitcherBasic) 팀별 필터로 선수 추출
 * KBO 로스터 페이지(/Team/Roster.aspx)가 다운됨 → 기록 페이지에서 추출
 */

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const CONSTANTS_DIR = join(PROJECT_ROOT, "src/lib/constants");

const TEAMS = [
  ["HT", "KIA", 6], ["OB", "두산", 2], ["LT", "롯데", 7],
  ["SS", "삼성", 8], ["SK", "SSG", 4], ["NC", "NC", 5],
  ["HH", "한화", 9], ["WO", "키움", 10], ["LG", "LG", 1], ["KT", "KT", 3],
];

const TEAM_SHORT_MAP = {
  "KIA": "KIA", "두산": "두산", "롯데": "롯데", "삼성": "삼성",
  "SSG": "SSG", "NC": "NC", "한화": "한화", "키움": "키움",
  "LG": "LG", "KT": "KT",
};

// Load existing roster for merging
let existingRoster = [];
try {
  existingRoster = JSON.parse(readFileSync(join(CONSTANTS_DIR, "players-roster.json"), "utf-8"));
} catch { /* first run */ }

const existingMap = new Map();
for (const p of existingRoster) {
  if (p.kboId) existingMap.set(p.kboId, p);
}

async function changeSelectAndWait(page, selector, value, waitMs = 8000) {
  const current = await page.$eval(selector, (el) => el.value).catch(() => null);
  if (current === value) return;

  const beforeFirstRow = await page.locator("tbody tr").first().textContent().catch(() => "");
  await page.selectOption(selector, value);

  try {
    await page.waitForFunction(
      ({ selector, value, beforeFirstRow }) => {
        const el = document.querySelector(selector);
        const firstRow = document.querySelector("tbody tr")?.textContent?.trim() || "";
        return !!el && el.value === value && firstRow !== beforeFirstRow;
      },
      { selector, value, beforeFirstRow },
      { timeout: waitMs }
    );
  } catch {
    await page.waitForTimeout(waitMs);
  }
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1000);
}

async function scrapeAllPages(page) {
  const allRows = [];
  let pageNum = 1;

  while (true) {
    const rows = await page.$$eval("tbody tr", (trs) =>
      trs.map((tr) => {
        const cells = [...tr.querySelectorAll("td")];
        return {
          texts: cells.map((td) => td.textContent.trim()),
          hrefs: cells.map((td) => {
            const a = td.querySelector("a");
            return a ? a.getAttribute("href") : "";
          }),
        };
      })
    );
    if (rows.length === 0) break;
    allRows.push(...rows);

    const targetPageText = String(pageNum + 1);
    const nextVisibleBtn = await page.locator('a[id*="ucPager_btnNo"]').filter({ hasText: targetPageText }).first();
    if (await nextVisibleBtn.count()) {
      await nextVisibleBtn.click();
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1200);
      pageNum++;
      continue;
    }

    const nextGroupBtn = await page.$('a[id$="btnNext"]');
    if (!nextGroupBtn) break;

    const beforePager = await page.$$eval('a[id*="ucPager_btnNo"]', (links) =>
      links.map((a) => `${a.textContent?.trim()}:${a.className}`).join("|")
    );
    await nextGroupBtn.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1200);
    const afterPager = await page.$$eval('a[id*="ucPager_btnNo"]', (links) =>
      links.map((a) => `${a.textContent?.trim()}:${a.className}`).join("|")
    );
    if (!afterPager || afterPager === beforePager) break;
    pageNum++;
  }

  return allRows;
}

function extractPlayerId(href) {
  const match = (href || "").match(/playerId=(\d+)/);
  return match ? match[1] : "";
}

async function main() {
  console.log("🏟️  KBO 로스터 크롤링 v2 (기록 페이지 기반)");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  const allPlayers = new Map();

  // Season selector IDs
  const seasonSel = "select[name$='ddlSeason$ddlSeason']";
  const seriesSel = "select[name$='ddlSeries$ddlSeries']";
  const teamSel = "select[name$='ddlTeam$ddlTeam']";

  // ===== BATTERS =====
  console.log("\n📊 타자 크롤링...");
  await page.goto("https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx", { waitUntil: "networkidle" });

  // Set series to regular season
  const hasSeries = await page.$(seriesSel);
  if (hasSeries) await changeSelectAndWait(page, seriesSel, "0", 5000);
  await changeSelectAndWait(page, seasonSel, "2026", 8000);

  for (const [teamCode, teamName, teamId] of TEAMS) {
    console.log(`  ${teamName}...`);
    await changeSelectAndWait(page, teamSel, teamCode, 8000);

    const rows = await scrapeAllPages(page);
    for (const r of rows) {
      const name = r.texts[1] || "";
      const team = r.texts[2] || "";
      const playerId = extractPlayerId(r.hrefs[1] || "");
      if (!name || !playerId) continue;

      allPlayers.set(playerId, {
        name,
        kboId: playerId,
        teamId,
        teamName,
        shortTeam: teamName,
        position: existingMap.get(playerId)?.position || "야수",
        backNo: existingMap.get(playerId)?.backNo || "",
      });
    }
    console.log(`    → ${rows.length}명`);

    // Reset team filter
    await changeSelectAndWait(page, teamSel, "", 5000).catch(() => {});
  }

  // ===== PITCHERS =====
  console.log("\n📊 투수 크롤링...");
  await page.goto("https://www.koreabaseball.com/Record/Player/PitcherBasic/Basic1.aspx", { waitUntil: "networkidle" });

  if (hasSeries) {
    const hasSeries2 = await page.$(seriesSel);
    if (hasSeries2) await changeSelectAndWait(page, seriesSel, "0", 5000);
  }
  await changeSelectAndWait(page, seasonSel, "2026", 8000);

  for (const [teamCode, teamName, teamId] of TEAMS) {
    console.log(`  ${teamName}...`);
    await changeSelectAndWait(page, teamSel, teamCode, 8000);

    const rows = await scrapeAllPages(page);
    for (const r of rows) {
      const name = r.texts[1] || "";
      const team = r.texts[2] || "";
      const playerId = extractPlayerId(r.hrefs[1] || "");
      if (!name || !playerId) continue;

      if (!allPlayers.has(playerId)) {
        allPlayers.set(playerId, {
          name,
          kboId: playerId,
          teamId,
          teamName,
          shortTeam: teamName,
          position: "투수",
          backNo: existingMap.get(playerId)?.backNo || "",
        });
      } else {
        // Update position if pitcher
        allPlayers.get(playerId).position = "투수";
      }
    }
    console.log(`    → ${rows.length}명`);

    await changeSelectAndWait(page, teamSel, "", 5000).catch(() => {});
  }

  await browser.close();

  // Merge with existing roster (keep existing players who have no 2026 stats yet)
  // But only if they have kboId format (not FP/AQ/TR)
  for (const [kboId, existing] of existingMap) {
    if (!allPlayers.has(kboId)) {
      // Keep foreign players and players who might not have played yet
      allPlayers.set(kboId, existing);
    }
  }

  const roster = [...allPlayers.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));

  console.log(`\n✅ 총 ${roster.length}명 (기존 ${existingRoster.length}명)`);

  // Check for 곽빈
  const kwakbin = roster.find(p => p.name === "곽빈");
  console.log("곽빈:", kwakbin ? `✅ ${kwakbin.kboId}` : "❌ 누락");

  writeFileSync(join(CONSTANTS_DIR, "players-roster.json"), JSON.stringify(roster, null, 2));
  console.log("Saved to src/lib/constants/players-roster.json");
}

main().catch((e) => {
  console.error("❌ 크롤링 실패:", e.message);
  process.exit(1);
});
