#!/usr/bin/env node
/**
 * KBO 공식 타자 통산표(BasicTotal) → 2025년 말 안타 기준선 snapshot.
 *
 * 같은 브라우저 세션에서 `전체 통산 H`와 `2026 시즌 H`를 연속 수집해 빼므로,
 * 서빙 시 앱의 최신 2026 H를 더하면 현재 통산 H가 된다. 서로 다른 시각의 static
 * 파일을 빼면 당일 기록이 기준선에 섞여 이중 합산되므로 사용하지 않는다.
 */
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAllPages, createKboPageAdapter } from "../lib/kbo-pagination.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const CAREER_URL = "https://www.koreabaseball.com/Record/Player/HitterBasic/BasicTotal.aspx";
const SEASON_URL = "https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx";
const OUTPUT = join(ROOT, "data/baseball-qa/kbo-career-hitter-through-2025.json");

function int(value, label) {
  if (!/^\d+$/.test(String(value ?? "").trim())) throw new Error(`${label}: invalid integer ${value}`);
  return Number(value);
}
function playerIdOf(href) {
  const id = String(href ?? "").match(/[?&]playerId=(\d+)/)?.[1];
  if (!id) throw new Error(`record row missing playerId: ${href}`);
  return id;
}
function parseHitRow(row) {
  const c = row.texts;
  if (c.length < 9) throw new Error(`record row has ${c.length} columns`);
  return {
    kboId: playerIdOf(row.hrefs[1]),
    name: c[1].replace(/^\*\s*/, "").trim(),
    team: c[2].trim(),
    hits: int(c[8], "H"),
  };
}
async function sortDescending(page, key) {
  const selector = `a[href="javascript:sort('${key}');"]`;
  for (let i = 0; i < 3; i++) {
    const state = await page.evaluate(() => ({
      col: document.querySelector('input[id$="hfOrderByCol"]')?.value,
      order: document.querySelector('input[id$="hfOrderBy"]')?.value,
    }));
    if (state.col === key && state.order === "DESC") return;
    const link = await page.$(selector);
    if (!link) throw new Error(`record sort link missing: ${key}`);
    await link.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(600);
  }
  throw new Error(`record sort did not settle: ${key}/DESC`);
}
async function collect(page, maxPages) {
  return collectAllPages({ ...createKboPageAdapter(page), log: (line) => console.log(line), maxPages });
}
async function ensureSeason(page, expected) {
  const selector = 'select[name$="ddlSeason$ddlSeason"]';
  const current = await page.locator(selector).inputValue();
  if (current === expected) return;
  await page.selectOption(selector, expected);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(600);
  const confirmed = await page.locator(selector).inputValue();
  if (confirmed !== expected) throw new Error(`season did not settle: ${confirmed} != ${expected}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(CAREER_URL, { waitUntil: "networkidle" });
    await ensureSeason(page, "9999");
    await sortDescending(page, "HIT_CN");
    const careerRows = (await collect(page, 120)).map(parseHitRow);
    if (careerRows.length < 2_000) throw new Error(`career H coverage too small: ${careerRows.length}`);
    for (let i = 1; i < careerRows.length; i++) {
      if (careerRows[i - 1].hits < careerRows[i].hits) throw new Error(`career H order invalid at ${i}`);
    }

    await page.goto(SEASON_URL, { waitUntil: "networkidle" });
    await ensureSeason(page, "2026");
    await sortDescending(page, "HIT_CN");
    const seasonRows = (await collect(page, 20)).map(parseHitRow);
    if (seasonRows.length < 250) throw new Error(`2026 H coverage too small: ${seasonRows.length}`);
    const currentById = new Map(seasonRows.map((row) => [row.kboId, row]));
    if (currentById.size !== seasonRows.length) throw new Error("2026 H duplicate playerId");

    const rows = careerRows.map((career) => {
      const current = currentById.get(career.kboId);
      if (current && current.name !== career.name) throw new Error(`identity mismatch: ${career.kboId}`);
      const hits = career.hits - (current?.hits ?? 0);
      if (!Number.isInteger(hits) || hits < 0) throw new Error(`baseline subtraction invalid: ${career.kboId}`);
      return { kboId: career.kboId, name: career.name, team: career.team, hits };
    });
    const capturedAt = new Date().toISOString();
    const payload = {
      schemaVersion: 1,
      throughSeason: 2025,
      source: { url: CAREER_URL, seasonValue: "9999", sortKey: "HIT_CN", order: "DESC" },
      derivedFrom: { careerUrl: CAREER_URL, currentSeasonUrl: SEASON_URL, currentSeason: 2026, capturedAt },
      rowCount: rows.length,
      rows,
    };
    const canonical = JSON.stringify(payload);
    payload.sha256 = createHash("sha256").update(canonical).digest("hex");
    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`wrote ${rows.length} rows -> ${OUTPUT}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
