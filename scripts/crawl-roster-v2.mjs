#!/usr/bin/env node
/**
 * KBO 로스터 크롤링 v2 - 기록 페이지(HitterBasic + PitcherBasic) 팀별 필터로 선수 추출
 * KBO 로스터 페이지(/Team/Roster.aspx)가 다운됨 → 기록 페이지에서 추출
 */

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { preserveExistingRosterPlayers } from "./lib/roster-preservation.mjs";
import {
  buildTeamBaseline,
  evaluateTeamCollection,
  evaluateRosterCompletion,
  formatCompletionFailure,
} from "./lib/roster-crawl-completion.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const CONSTANTS_DIR = join(PROJECT_ROOT, "src/lib/constants");

const TEAMS = [
  ["HT", "KIA", 6], ["OB", "두산", 2], ["LT", "롯데", 7],
  ["SS", "삼성", 8], ["SK", "SSG", 4], ["NC", "NC", 5],
  ["HH", "한화", 9], ["WO", "키움", 10], ["LG", "LG", 1], ["KT", "KT", 3],
];

// Load existing roster for merging
let existingRoster = [];
try {
  existingRoster = JSON.parse(readFileSync(join(CONSTANTS_DIR, "players-roster.json"), "utf-8"));
} catch { /* first run */ }

const existingMap = new Map();
for (const p of existingRoster) {
  if (p.kboId) existingMap.set(String(p.kboId), p);
}

const foreignMapSource = readFileSync(join(CONSTANTS_DIR, "foreign-id-map.ts"), "utf-8");
const FOREIGN_NUMERIC_TO_ALPHA = Object.fromEntries(
  [...foreignMapSource.matchAll(/"(\d+)":\s*"((?:FP|AQ)\d+)"/g)].map((m) => [m[1], m[2]])
);

function canonicalKboId(playerId) {
  return FOREIGN_NUMERIC_TO_ALPHA[playerId] || playerId;
}

function existingFor(playerId) {
  return existingMap.get(canonicalKboId(playerId)) || existingMap.get(playerId);
}

function upsertScrapedPlayer(allPlayers, { playerId, name, teamId, teamName, position }) {
  const canonicalId = canonicalKboId(playerId);
  const existing = existingFor(playerId);
  const prev = allPlayers.get(canonicalId);

  allPlayers.set(canonicalId, {
    ...prev,
    name: existing?.name || prev?.name || name,
    kboId: canonicalId,
    teamId,
    team: teamName,
    position: position || prev?.position || existing?.position || "야수",
    backNo: existing?.backNo || prev?.backNo || "",
    // 생년월일은 상세페이지 방문에서만 채워지므로 기존값 보존 (전수 재방문 방지).
    birthDate: existing?.birthDate ?? prev?.birthDate ?? null,
    _numericId: /^\d+$/.test(playerId) ? playerId : prev?._numericId,
  });
}

// "2000년 07월 12일" -> "2000-07-12"
function parseKboBirthday(text) {
  const m = /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/.exec(text || "");
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * 셀렉트를 바꾸고 표가 갱신될 때까지 기다린다.
 * @returns {Promise<boolean>} 셀렉트가 *실제로* 요청값을 들고 있는지.
 *   false 면 화면이 직전 팀 데이터일 수 있으므로 그 수집 결과를 신뢰하면 안 된다.
 *   (기존 판은 timeout 시 조용히 진행해 직전 팀 표를 그대로 긁었다.)
 */
async function changeSelectAndWait(page, selector, value, waitMs = 8000) {
  const current = await page.$eval(selector, (el) => el.value).catch(() => null);
  if (current === value) return true;

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

  const settled = await page.$eval(selector, (el) => el.value).catch(() => null);
  return settled === value;
}

/**
 * 팀 1개를 완주 계약 아래에서 수집한다. 실패 사유가 있으면 bounded retry.
 * 수집된 행은 판정이 ok 일 때만 반영한다 — 오염 데이터를 넣고 나중에 되돌리지 않는다.
 */
async function collectTeamWithContract({
  page,
  teamSel,
  teamCode,
  teamName,
  teamId,
  phase,
  baseline,
  applyRows,
  maxAttempts = 3,
}) {
  let result = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    // 재시도 전에는 필터를 비워 셀렉트 상태를 확실히 되돌린다.
    if (attempt > 1) {
      await changeSelectAndWait(page, teamSel, "", 5000).catch(() => {});
      await page.waitForTimeout(1500);
    }

    const selectConfirmed = await changeSelectAndWait(page, teamSel, teamCode, 8000);
    const rows = selectConfirmed ? await scrapeAllPages(page) : [];
    const usable = rows.filter((r) => (r.texts[1] || "") && extractPlayerId(r.hrefs[1] || ""));

    result = evaluateTeamCollection({
      selectConfirmed,
      collected: usable.length,
      baseline,
    });

    if (result.ok) {
      applyRows(usable, teamId, teamName);
      console.log(`    → ${usable.length}명 (시도 ${attempt})`);
      break;
    }

    console.log(`    ⚠️ ${teamName} 수집 판정 실패: ${result.reason} (${result.detail}) — 시도 ${attempt}/${maxAttempts}`);
  }

  await changeSelectAndWait(page, teamSel, "", 5000).catch(() => {});
  return { teamName, phase, result, attempts };
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
  const teamBaseline = buildTeamBaseline(existingRoster);
  const teamOutcomes = [];

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
    teamOutcomes.push(
      await collectTeamWithContract({
        page,
        teamSel,
        teamCode,
        teamName,
        teamId,
        phase: "batters",
        baseline: teamBaseline.get(teamId),
        applyRows: (rows, tid, tname) => {
          for (const r of rows) {
            const playerId = extractPlayerId(r.hrefs[1] || "");
            upsertScrapedPlayer(allPlayers, {
              playerId,
              name: r.texts[1] || "",
              teamId: tid,
              teamName: tname,
              position: existingFor(playerId)?.position || "야수",
            });
          }
        },
      })
    );
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
    teamOutcomes.push(
      await collectTeamWithContract({
        page,
        teamSel,
        teamCode,
        teamName,
        teamId,
        phase: "pitchers",
        // 투수 페이지 baseline 은 팀 전체 인원이 아니라 투수만이라 floor 만 적용한다.
        baseline: undefined,
        applyRows: (rows, tid, tname) => {
          for (const r of rows) {
            const playerId = extractPlayerId(r.hrefs[1] || "");
            upsertScrapedPlayer(allPlayers, {
              playerId,
              name: r.texts[1] || "",
              teamId: tid,
              teamName: tname,
              position: "투수",
            });
          }
        },
      })
    );
  }

  // 완주 계약: 한 팀이라도 실패하면 저장하지 않는다.
  // 부분 수집을 정상 완주로 저장하던 결손이 `②-b roster 자동머지 보류` 의 근거였다.
  const completion = evaluateRosterCompletion(teamOutcomes, TEAMS.length * 2);
  if (!completion.complete) {
    await browser.close();
    console.error(`\n${formatCompletionFailure(completion)}`);
    process.exit(1);
  }
  console.log(`\n✅ 수집 완주 계약 통과 — ${completion.summary}`);

  // ===== 상세페이지 보강 (등번호 + 생년월일) =====
  // 기록 페이지(HitterBasic/PitcherBasic)에는 등번호·생년월일이 없음.
  // 선수 상세 페이지(PitcherDetail/HitterDetail)에서 #lblBackNo·#lblBirthday 스팬을 긁어 채움.
  // 등번호 또는 생년월일이 비어있는 선수만 방문 — 부하 최소화(생년월일 백필 후엔 신규만).
  const needsDetail = [...allPlayers.values()].filter((p) => {
    const missingBackNo = !(p.backNo && String(p.backNo).trim() !== "");
    const missingBirth = !p.birthDate;
    if (!missingBackNo && !missingBirth) return false;
    // KBO 숫자형 playerId만 상세 페이지가 존재. 외국인 canonical(FP/AQ)은
    // 스탯 페이지에서 발견한 숫자 alias(_numericId)로 보강한다.
    return /^\d+$/.test(p._numericId || p.kboId || "");
  });
  if (needsDetail.length > 0) {
    console.log(`\n🔢 상세 보강(등번호·생년월일): ${needsDetail.length}명 개별 페이지 방문`);
    let filled = 0;
    let failed = 0;
    for (let i = 0; i < needsDetail.length; i++) {
      const p = needsDetail[i];
      // 포지션에 따라 Pitcher/Hitter detail URL 선택 (둘 다 구조 동일, 실패 시 다른 쪽 재시도)
      const detailPlayerId = p._numericId || p.kboId;
      const urls = p.position === "투수"
        ? [
            `https://www.koreabaseball.com/Record/Player/PitcherDetail/Basic.aspx?playerId=${detailPlayerId}`,
            `https://www.koreabaseball.com/Record/Player/HitterDetail/Basic.aspx?playerId=${detailPlayerId}`,
          ]
        : [
            `https://www.koreabaseball.com/Record/Player/HitterDetail/Basic.aspx?playerId=${detailPlayerId}`,
            `https://www.koreabaseball.com/Record/Player/PitcherDetail/Basic.aspx?playerId=${detailPlayerId}`,
          ];
      let backNo = "";
      let birthDate = null;
      for (const url of urls) {
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
          backNo = await page.$eval(
            "#cphContents_cphContents_cphContents_playerProfile_lblBackNo",
            (el) => el.textContent.trim()
          ).catch(() => "");
          const birthTxt = await page.$eval(
            "#cphContents_cphContents_cphContents_playerProfile_lblBirthday",
            (el) => el.textContent.trim()
          ).catch(() => "");
          birthDate = parseKboBirthday(birthTxt);
          if (backNo || birthDate) break;
        } catch { /* try next url */ }
      }
      const rec = allPlayers.get(p.kboId);
      if (backNo && !(rec.backNo && String(rec.backNo).trim() !== "")) rec.backNo = backNo;
      if (birthDate && !rec.birthDate) rec.birthDate = birthDate;
      if (backNo || birthDate) filled++;
      else failed++;
      if ((i + 1) % 20 === 0) {
        console.log(`  진행 ${i + 1}/${needsDetail.length} (fill=${filled}, fail=${failed})`);
      }
    }
    console.log(`  ✅ 상세 보강 완료: 성공 ${filled}명, 실패 ${failed}명`);
  }

  await browser.close();

  // Merge with existing roster (keep existing players who have no 2026 stats yet).
  // If a numeric KBO id is an alias of an FP/AQ foreign canonical id, never
  // re-add it as a separate roster row.
  const preserved = preserveExistingRosterPlayers(allPlayers, existingMap, canonicalKboId);
  console.log(`  기존 roster 보존(군 복무·미출장 포함): ${preserved}명`);

  const roster = [...allPlayers.values()]
    .map((p) => ({
      name: p.name,
      kboId: p.kboId,
      teamId: p.teamId,
      position: p.position,
      backNo: p.backNo || "0",
      team: p.team || p.teamName || p.shortTeam,
      birthDate: p.birthDate ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));

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
