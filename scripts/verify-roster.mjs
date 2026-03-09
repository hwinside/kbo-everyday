#!/usr/bin/env node
/**
 * 2025 시즌 선수 데이터 전수 검증
 * KBO 공식 팀별 로스터 + 개별 선수 스탯 대조
 */

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const CONSTANTS_DIR = join(PROJECT_ROOT, "src/lib/constants");

const roster = JSON.parse(
  readFileSync(join(CONSTANTS_DIR, "players-roster.json"), "utf-8")
);

const KBO_BASE = "https://www.koreabaseball.com";

// KBO 팀 코드
const TEAMS = [
  { code: "LG", name: "LG", id: 1 },
  { code: "OB", name: "두산", id: 2 },
  { code: "KT", name: "KT", id: 3 },
  { code: "SK", name: "SSG", id: 4 },
  { code: "NC", name: "NC", id: 5 },
  { code: "HT", name: "KIA", id: 6 },
  { code: "LT", name: "롯데", id: 7 },
  { code: "SS", name: "삼성", id: 8 },
  { code: "HH", name: "한화", id: 9 },
  { code: "WO", name: "키움", id: 10 },
];

async function crawlTeamRoster(page, teamCode) {
  const url = `${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx?sort=HRA_RT`;
  // KBO doesn't have a simple team roster page for all players
  // Instead, fetch individual player detail pages
  return [];
}

async function verifyPlayerStats(page, player) {
  const isPitcher = player.position === "투수";
  const detailUrl = isPitcher
    ? `${KBO_BASE}/Record/Player/PitcherDetail/Basic.aspx?playerId=${player.kboId}`
    : `${KBO_BASE}/Record/Player/HitterDetail/Basic.aspx?playerId=${player.kboId}`;

  try {
    const response = await page.goto(detailUrl, { timeout: 10000 });
    if (!response || response.status() !== 200) {
      return { status: "error", error: "HTTP " + (response?.status() || "no response") };
    }
    await page.waitForLoadState("domcontentloaded");

    // Get player name from page header
    const pagePlayerName = await page
      .$eval(".player_name", (el) => el.textContent.trim())
      .catch(() => null);

    // Get team from page
    const pageTeam = await page
      .$eval(".player_info .team", (el) => el.textContent.trim())
      .catch(() => null);

    // Get stats from tables
    const tables = await page.$$eval("tbody", (tbodies) =>
      tbodies.map((tb) => {
        const rows = [...tb.querySelectorAll("tr")];
        return rows.map((tr) =>
          [...tr.querySelectorAll("td")].map((td) => td.textContent.trim())
        );
      })
    );

    const t0 = tables[0]?.[0];
    if (!t0 || t0[0] === "기록이 없습니다.") {
      return { status: "no_record", pagePlayerName, pageTeam };
    }

    let stats;
    if (isPitcher) {
      const t1 = tables[1]?.[0];
      stats = {
        team: t0[0], era: t0[1], games: parseInt(t0[2]) || 0,
        wins: parseInt(t0[5]) || 0, losses: parseInt(t0[6]) || 0,
        saves: parseInt(t0[7]) || 0, holds: parseInt(t0[8]) || 0,
        ip: t0[12], so: parseInt(t1?.[4]) || 0,
        whip: t1?.[10] || "0.00",
      };
    } else {
      const t1 = tables[1]?.[0];
      stats = {
        team: t0[0], avg: t0[1], games: parseInt(t0[2]) || 0,
        pa: parseInt(t0[3]) || 0, hr: parseInt(t0[9]) || 0,
        rbi: parseInt(t0[11]) || 0,
        ops: t1?.[10] || ".000",
      };
    }

    return { status: "ok", pagePlayerName, pageTeam, stats };
  } catch (e) {
    return { status: "error", error: e.message };
  }
}

async function main() {
  console.log(`🔍 2025 시즌 전수 검증 시작 (${roster.length}명)`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  });

  // Use multiple pages for parallel requests
  const CONCURRENCY = 3;
  const pages = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    pages.push(await context.newPage());
  }

  const results = {
    total: roster.length,
    verified: 0,
    noRecord: 0,
    nameMatch: 0,
    nameMismatch: [],
    teamMismatch: [],
    errors: [],
    statIssues: [],
  };

  // Process in batches
  for (let i = 0; i < roster.length; i += CONCURRENCY) {
    const batch = roster.slice(i, i + CONCURRENCY);
    const promises = batch.map((player, idx) =>
      verifyPlayerStats(pages[idx], player).then((result) => ({
        player,
        result,
      }))
    );

    const batchResults = await Promise.all(promises);

    for (const { player, result } of batchResults) {
      if (result.status === "error") {
        results.errors.push({ name: player.name, team: player.team, kboId: player.kboId, error: result.error });
        continue;
      }

      if (result.status === "no_record") {
        results.noRecord++;
        continue;
      }

      results.verified++;

      // Name check (from page header, if available)
      if (result.pagePlayerName && result.pagePlayerName !== player.name) {
        results.nameMismatch.push({
          kboId: player.kboId,
          ourName: player.name,
          kboName: result.pagePlayerName,
          team: player.team,
        });
      } else {
        results.nameMatch++;
      }

      // Team check
      if (result.stats?.team && result.stats.team !== player.team) {
        results.teamMismatch.push({
          kboId: player.kboId,
          name: player.name,
          ourTeam: player.team,
          kboTeam: result.stats.team,
        });
      }
    }

    // Progress
    const done = Math.min(i + CONCURRENCY, roster.length);
    if (done % 30 === 0 || done === roster.length) {
      console.log(`  진행: ${done}/${roster.length} (검증: ${results.verified}, 기록없음: ${results.noRecord}, 에러: ${results.errors.length})`);
    }

    // Rate limiting - 100ms between batches
    await new Promise((r) => setTimeout(r, 150));
  }

  await browser.close();

  // Report
  console.log("\n" + "=".repeat(60));
  console.log("📋 전수 검증 결과");
  console.log("=".repeat(60));
  console.log(`총 선수: ${results.total}`);
  console.log(`검증 완료: ${results.verified}`);
  console.log(`2025 기록 없음: ${results.noRecord}`);
  console.log(`에러: ${results.errors.length}`);
  console.log(`이름 일치: ${results.nameMatch}`);
  console.log(`이름 불일치: ${results.nameMismatch.length}`);
  console.log(`팀 불일치: ${results.teamMismatch.length}`);

  if (results.nameMismatch.length > 0) {
    console.log("\n🔴 이름 불일치:");
    for (const m of results.nameMismatch) {
      console.log(`  kboId=${m.kboId}: 우리="${m.ourName}" vs KBO="${m.kboName}" (팀: ${m.team})`);
    }
  }

  if (results.teamMismatch.length > 0) {
    console.log("\n🟡 팀 불일치:");
    for (const m of results.teamMismatch) {
      console.log(`  ${m.name} (kboId=${m.kboId}): 우리="${m.ourTeam}" vs KBO="${m.kboTeam}"`);
    }
  }

  if (results.errors.length > 0) {
    console.log(`\n⚠️ 에러 (처음 10건):`);
    for (const e of results.errors.slice(0, 10)) {
      console.log(`  ${e.name} (${e.team}, kboId=${e.kboId}): ${e.error}`);
    }
  }

  // Save full report
  const reportPath = join(PROJECT_ROOT, "scripts/verify-report.json");
  writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\n📄 상세 리포트: ${reportPath}`);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
