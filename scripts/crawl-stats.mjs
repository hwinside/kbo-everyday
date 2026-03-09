#!/usr/bin/env node
/**
 * KBO 공식 사이트에서 타자/투수 스탯 크롤링 → static JSON 생성
 * Usage: node scripts/crawl-stats.mjs [--season 2025]
 *
 * 페이지: Basic1 (타자 기본 + 투수 전체) + Basic2 (타자 추가: BB/HBP/SO/SLG/OBP/OPS)
 * + Runner (도루)
 * 페이징: ASP.NET ViewState → Playwright 사용
 */

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const CONSTANTS_DIR = join(PROJECT_ROOT, "src/lib/constants");

const KBO_BASE = "https://www.koreabaseball.com";
const SEASON = process.argv.includes("--season")
  ? process.argv[process.argv.indexOf("--season") + 1]
  : "2025";

// Load roster for kboId matching
let roster = [];
try {
  roster = JSON.parse(
    readFileSync(join(CONSTANTS_DIR, "players-roster.json"), "utf-8")
  );
} catch {
  console.warn("⚠️  players-roster.json not found, kboId matching disabled");
}

function findKboId(name, team) {
  // Try exact name match, prefer same team
  const matches = roster.filter((p) => p.name === name);
  if (matches.length === 1) return matches[0].kboId || "";
  const teamMatch = matches.find((p) => p.teamName === team || p.shortTeam === team);
  return teamMatch?.kboId || matches[0]?.kboId || "";
}

// Extract playerId from href like /Record/Player/HitterDetail/Basic.aspx?playerId=76232
function extractPlayerId(html) {
  const match = html.match(/playerId=(\d+)/);
  return match ? match[1] : "";
}

async function selectSeason(page) {
  // Select season from dropdown
  const seasonSelector =
    "select[name$='ddlSeason$ddlSeason']";
  const current = await page.$eval(seasonSelector, (el) => el.value).catch(() => null);
  if (current !== SEASON) {
    await page.selectOption(seasonSelector, SEASON);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
  }
}

async function scrapeTable(page) {
  return page.$$eval("tbody tr", (rows) =>
    rows.map((tr) => {
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
}

async function scrapeAllPages(page) {
  const allRows = [];
  let pageNum = 1;

  while (true) {
    const rows = await scrapeTable(page);
    if (rows.length === 0) break;
    allRows.push(...rows);
    console.log(`    Page ${pageNum}: ${rows.length} rows (total: ${allRows.length})`);

    // KBO uses numbered page buttons: btnNo1, btnNo2, ...
    const nextBtnId = `cphContents_cphContents_cphContents_ucPager_btnNo${pageNum + 1}`;
    const nextBtn = await page.$(`#${nextBtnId}`);
    if (!nextBtn) {
      // Try "다음" or "마지막" button group navigation
      const nextGroupBtn = await page.$(`a[id$="btnNext"]`);
      if (nextGroupBtn) {
        await nextGroupBtn.click();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(800);
        pageNum++;
        continue;
      }
      break;
    }

    // Check if this button has class "on" (already active) — shouldn't happen, but just in case
    const isActive = await nextBtn.evaluate((el) => el.classList.contains("on"));
    if (isActive) break;

    await nextBtn.click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);
    pageNum++;
  }

  return allRows;
}

async function crawlBatterBasic1(page) {
  console.log("\n📊 타자 Basic1 크롤링...");
  await page.goto(
    `${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx?sort=HRA_RT`
  );
  await page.waitForLoadState("networkidle");
  await selectSeason(page);

  const rows = await scrapeAllPages(page);

  // Columns: 순위(0) 선수명(1) 팀명(2) AVG(3) G(4) PA(5) AB(6) R(7) H(8) 2B(9) 3B(10) HR(11) TB(12) RBI(13) SAC(14) SF(15)
  return rows.map((r, i) => {
    const c = r.texts;
    const playerId = extractPlayerId(r.hrefs[1] || "");
    return {
      name: c[1] || "",
      team: c[2] || "",
      avg: c[3] || ".000",
      games: parseInt(c[4]) || 0,
      pa: parseInt(c[5]) || 0,
      ab: parseInt(c[6]) || 0,
      runs: parseInt(c[7]) || 0,
      hits: parseInt(c[8]) || 0,
      doubles: parseInt(c[9]) || 0,
      triples: parseInt(c[10]) || 0,
      hr: parseInt(c[11]) || 0,
      tb: parseInt(c[12]) || 0,
      rbi: parseInt(c[13]) || 0,
      sac: parseInt(c[14]) || 0,
      sf: parseInt(c[15]) || 0,
      _playerId: playerId,
    };
  });
}

async function crawlBatterBasic2(page) {
  console.log("\n📊 타자 Basic2 크롤링...");
  await page.goto(
    `${KBO_BASE}/Record/Player/HitterBasic/Basic2.aspx?sort=HRA_RT`
  );
  await page.waitForLoadState("networkidle");
  await selectSeason(page);

  const rows = await scrapeAllPages(page);

  // Columns: 순위(0) 선수명(1) 팀명(2) AVG(3) BB(4) IBB(5) HBP(6) SO(7) GDP(8) SLG(9) OBP(10) OPS(11) MH(12) RISP(13) PH-BA(14)
  return rows.map((r) => {
    const c = r.texts;
    return {
      name: c[1] || "",
      team: c[2] || "",
      bb: parseInt(c[4]) || 0,
      ibb: parseInt(c[5]) || 0,
      hbp: parseInt(c[6]) || 0,
      so: parseInt(c[7]) || 0,
      gdp: parseInt(c[8]) || 0,
      slg: c[9] || ".000",
      obp: c[10] || ".000",
      ops: c[11] || ".000",
    };
  });
}

async function crawlRunner(page) {
  console.log("\n📊 도루 크롤링...");
  await page.goto(`${KBO_BASE}/Record/Player/Runner/Basic.aspx`);
  await page.waitForLoadState("networkidle");
  await selectSeason(page);

  const rows = await scrapeAllPages(page);

  // Columns: 순위(0) 선수명(1) 팀명(2) G(3) SBA(4) SB(5) CS(6) SB%(7) OOB(8) PKO(9)
  return rows.map((r) => {
    const c = r.texts;
    return {
      name: c[1] || "",
      team: c[2] || "",
      sb: parseInt(c[5]) || 0,
      cs: parseInt(c[6]) || 0,
    };
  });
}

async function crawlPitcher(page) {
  console.log("\n📊 투수 Basic1 크롤링...");
  await page.goto(
    `${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx?sort=ERA_RT`
  );
  await page.waitForLoadState("networkidle");
  await selectSeason(page);

  const rows = await scrapeAllPages(page);

  // Columns: 순위(0) 선수명(1) 팀명(2) ERA(3) G(4) W(5) L(6) SV(7) HLD(8) WPCT(9) IP(10) H(11) HR(12) BB(13) HBP(14) SO(15) R(16) ER(17) WHIP(18)
  return rows.map((r, i) => {
    const c = r.texts;
    const playerId = extractPlayerId(r.hrefs[1] || "");
    const name = c[1] || "";
    const team = c[2] || "";
    const kboId = playerId || findKboId(name, team);

    return {
      rank: i + 1,
      name,
      team,
      era: c[3] || "0.00",
      games: parseInt(c[4]) || 0,
      wins: parseInt(c[5]) || 0,
      losses: parseInt(c[6]) || 0,
      saves: parseInt(c[7]) || 0,
      holds: parseInt(c[8]) || 0,
      wpct: c[9] || "0.000",
      ip: c[10] || "0",
      h: parseInt(c[11]) || 0,
      hr: parseInt(c[12]) || 0,
      bb: parseInt(c[13]) || 0,
      hbp: parseInt(c[14]) || 0,
      so: parseInt(c[15]) || 0,
      r: parseInt(c[16]) || 0,
      er: parseInt(c[17]) || 0,
      whip: c[18] || "0.00",
      kboId,
      playerId: kboId,
    };
  });
}

function parseIpToFloat(ip) {
  // "180 2/3" → 180.67, "164 1/3" → 164.33
  if (!ip || ip === "0") return 0;
  const parts = ip.split(" ");
  let whole = parseInt(parts[0]) || 0;
  if (parts[1]) {
    const frac = parts[1].split("/");
    whole += (parseInt(frac[0]) || 0) / (parseInt(frac[1]) || 1);
  }
  return Math.round(whole * 100) / 100;
}

async function main() {
  console.log(`🏟️  KBO 스탯 크롤링 시작 (시즌: ${SEASON})`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    // ===== BATTERS =====
    const basic1 = await crawlBatterBasic1(page);
    const basic2 = await crawlBatterBasic2(page);
    const runner = await crawlRunner(page);

    // Merge batter data
    console.log("\n🔗 타자 데이터 병합...");
    const batterMap = new Map();

    for (const b of basic1) {
      const key = `${b.name}|${b.team}`;
      batterMap.set(key, { ...b });
    }

    for (const b2 of basic2) {
      const key = `${b2.name}|${b2.team}`;
      const existing = batterMap.get(key);
      if (existing) {
        Object.assign(existing, {
          bb: b2.bb,
          ibb: b2.ibb,
          hbp: b2.hbp,
          so: b2.so,
          gdp: b2.gdp,
          slg: b2.slg,
          obp: b2.obp,
          ops: b2.ops,
        });
      }
    }

    for (const r of runner) {
      const key = `${r.name}|${r.team}`;
      const existing = batterMap.get(key);
      if (existing) {
        existing.sb = r.sb;
        existing.cs = r.cs;
      }
    }

    // Sort by AVG desc and assign ranks + kboId
    const batters = [...batterMap.values()]
      .sort((a, b) => parseFloat(b.avg) - parseFloat(a.avg))
      .map((b, i) => {
        const kboId = b._playerId || findKboId(b.name, b.team);
        delete b._playerId;
        return {
          rank: i + 1,
          ...b,
          sb: b.sb || 0,
          cs: b.cs || 0,
          bb: b.bb || 0,
          hbp: b.hbp || 0,
          so: b.so || 0,
          slg: b.slg || ".000",
          obp: b.obp || ".000",
          ops: b.ops || ".000",
          kboId,
          playerId: kboId,
        };
      });

    // ===== PITCHERS =====
    const pitchers = await crawlPitcher(page);

    // ===== SAVE =====
    const batterPath = join(CONSTANTS_DIR, `stats-${SEASON}-batters.json`);
    const pitcherPath = join(CONSTANTS_DIR, `stats-${SEASON}-pitchers.json`);

    writeFileSync(batterPath, JSON.stringify(batters, null, 2));
    writeFileSync(pitcherPath, JSON.stringify(pitchers, null, 2));

    console.log(`\n✅ 타자 ${batters.length}명 → ${batterPath}`);
    console.log(`✅ 투수 ${pitchers.length}명 → ${pitcherPath}`);

    // Validation: compare top 5 with expected
    console.log("\n📋 타자 Top 5:");
    batters.slice(0, 5).forEach((b) =>
      console.log(
        `  ${b.rank}. ${b.name} (${b.team}) AVG ${b.avg} G${b.games} PA${b.pa} HR${b.hr} RBI${b.rbi} OPS${b.ops}`
      )
    );

    console.log("\n📋 투수 Top 5:");
    pitchers.slice(0, 5).forEach((p) =>
      console.log(
        `  ${p.rank}. ${p.name} (${p.team}) ERA ${p.era} G${p.games} W${p.wins} L${p.losses} IP${p.ip} SO${p.so} WHIP${p.whip}`
      )
    );
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("❌ 크롤링 실패:", e.message);
  process.exit(1);
});
