#!/usr/bin/env node
/**
 * KBO 공식 통산표 → 2025년 말 **다지표** 기준선 snapshot (타자/투수).
 *
 * #1159 의 안타 전용 크롤러(`crawl-kbo-career-hitter.mjs`)를 지표 축으로 넓힌 것이다.
 * 계약은 그대로 유지한다:
 *   같은 세션에서 `전체 통산`과 `2026 시즌`을 연속 수집해 빼면 2025년 말 기준선이 되고,
 *   서빙 시 앱의 최신 2026 값을 더하면 현재 통산이 된다. 서로 다른 시각의 static 파일을
 *   빼면 당일 기록이 기준선에 섞여 이중 합산되므로 절대 그렇게 하지 않는다.
 *
 * ⚠️ **지표마다 재크롤하지 않는다.** 통산표는 모든 컬럼을 매 행에 담으므로(실측 2026-08-12)
 *   한 번 전 페이지를 훑어 전 컬럼을 파싱한다. 순위는 서빙 시 코드가 정렬해 만든다.
 *   정렬은 "전 페이지를 확실히 도는" 용도로만 쓴다(안정 정렬키 1개면 충분).
 *
 * 2026 시즌 값 출처 (실측):
 *   타자 — Basic1(G PA AB R H 2B 3B HR TB RBI) + Basic2(BB HBP SO GDP) + 주루(SB)
 *   투수 — Basic1(G W L SV HLD H HR BB HBP SO R ER) 한 장이면 전부 있다
 */
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAllPages, createKboPageAdapter } from "../lib/kbo-pagination.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const BASE = "https://www.koreabaseball.com/Record/Player";

const HITTER_CAREER_URL = `${BASE}/HitterBasic/BasicTotal.aspx`;
const PITCHER_CAREER_URL = `${BASE}/PitcherBasic/BasicTotal.aspx`;

const OUTPUT = join(ROOT, "data/baseball-qa/kbo-career-metrics-through-2025.json");

/**
 * 통산표 컬럼 배치(실측 2026-08-12). 인덱스는 `순위 선수명 팀명` 다음부터 센다.
 * 파싱 전에 **헤더를 대조**해 배치가 바뀌면 즉시 죽는다 — 조용히 다른 컬럼을 읽으면
 * 홈런 자리에 타점이 들어가는 식의 오염이 그대로 서빙된다.
 */
const HITTER_CAREER_HEAD = ["순위", "선수명", "팀명", "AVG", "G", "PA", "AB", "R", "H", "2B", "3B", "HR", "TB", "RBI", "SB", "BB", "HBP", "SO", "GDP", "E"];
const PITCHER_CAREER_HEAD = ["순위", "선수명", "팀명", "ERA", "G", "CG", "SHO", "W", "L", "SV", "HLD", "WPCT", "TBF", "IP", "H", "HR", "BB", "HBP", "SO", "R", "ER"];

/** 카탈로그 키 → 통산표 컬럼 헤더. `career-metric-catalog.ts` 와 같은 집합이어야 한다. */
const HITTER_METRICS = {
  games: "G", pa: "PA", ab: "AB", runs: "R", hits: "H", doubles: "2B", triples: "3B",
  hr: "HR", tb: "TB", rbi: "RBI", sb: "SB", bb: "BB", hbp: "HBP", so: "SO", gdp: "GDP",
};
const PITCHER_METRICS = {
  games: "G", wins: "W", losses: "L", saves: "SV", holds: "HLD",
  h: "H", hr: "HR", bb: "BB", hbp: "HBP", so: "SO", r: "R", er: "ER",
};

/**
 * 2026 시즌 값 출처 — `{url, sortKey, metrics}`.
 *
 * ⚠️ `sortKey` 는 반드시 **counting 지표(`_CN`)** 로 둔다(실측 2026-08-12).
 *   시즌 페이지의 기본 정렬은 비율 지표(`HRA_RT`=타율, `ERA_RT`)이고, 그 뷰는
 *   **규정타석·규정이닝 충족자만** 보여준다 — `Basic1` 이 44행(pager 1,2)에서 멈춘다.
 *   counting 키로 한 번 정렬하면 pager 가 `1,2,3,4,5` 로 늘며 전체 명단이 열린다.
 *   #1159 크롤러가 250행을 받았던 것도 `HIT_CN` 으로 정렬했기 때문이다.
 *   비율 정렬로 두면 비규정 선수가 통째로 빠져 **기준선이 과대 계산**된다(통산에서
 *   뺌 값이 0 이 돼 올시즌 기록이 기준선에 실려 이중 합산된다).
 */
const HITTER_SEASON_SOURCES = [
  [`${BASE}/HitterBasic/Basic1.aspx`, "HIT_CN", { games: "G", pa: "PA", ab: "AB", runs: "R", hits: "H", doubles: "2B", triples: "3B", hr: "HR", tb: "TB", rbi: "RBI" }],
  [`${BASE}/HitterBasic/Basic2.aspx`, "BB_CN", { bb: "BB", hbp: "HBP", so: "SO", gdp: "GDP" }],
  [`${BASE}/Runner/Basic.aspx`, "GAME_CN", { sb: "SB" }],
];
const PITCHER_SEASON_SOURCES = [
  [`${BASE}/PitcherBasic/Basic1.aspx`, "GAME_CN", { games: "G", wins: "W", losses: "L", saves: "SV", holds: "HLD", h: "H", hr: "HR", bb: "BB", hbp: "HBP", so: "SO", r: "R", er: "ER" }],
];

function int(value, label) {
  const raw = String(value ?? "").trim().replace(/,/g, "");
  if (!/^\d+$/.test(raw)) throw new Error(`${label}: invalid integer ${JSON.stringify(value)}`);
  return Number(raw);
}
function playerIdOf(href) {
  const id = String(href ?? "").match(/[?&]playerId=(\d+)/)?.[1];
  if (!id) throw new Error(`record row missing playerId: ${href}`);
  return id;
}

/**
 * 헤더 셀 정규화.
 *
 * ⚠️ 정렬된 컬럼은 헤더에 한글 라벨이 붙는다(실측: `H` → `H안타`, `G` → `G경기`).
 *   그걸 그대로 비교하면 "정렬한 컬럼만" 매번 불일치해 죽는다.
 *   영문·숫자로 시작하는 셀은 뒤따라붙는 한글을 벗기고, `순위`·`선수명` 같은
 *   순수 한글 셀은 그대로 둔다.
 */
function normalizeHeadCell(text) {
  const raw = String(text ?? "").trim();
  const m = raw.match(/^([A-Za-z0-9][A-Za-z0-9/%+.-]*)[가-힣]+$/);
  return m ? m[1] : raw;
}

async function readHead(page) {
  const raw = await page.$$eval("table thead th", (th) => th.map((t) => t.textContent.trim()));
  return raw.map(normalizeHeadCell);
}

/**
 * 헤더를 실제로 읽어 컬럼 인덱스를 만든다. 하드코딩한 인덱스를 쓰지 않는 이유:
 * KBO 가 컬럼을 하나 끼워 넣으면 전 지표가 한 칸씩 밀려 조용히 오염된다.
 */
function columnIndex(head, expectedHead, label) {
  if (head.length !== expectedHead.length || head.some((h, i) => h !== expectedHead[i])) {
    throw new Error(`${label}: header changed\n  expected ${expectedHead.join(" ")}\n  actual   ${head.join(" ")}`);
  }
  const index = {};
  head.forEach((name, i) => { if (!(name in index)) index[name] = i; });
  return index;
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

async function collect(page, maxPages) {
  return collectAllPages({ ...createKboPageAdapter(page), log: (line) => console.log(line), maxPages });
}

/** 한 표를 전 페이지 훑어 `{kboId, name, team, values:{키:정수}}` 로 만든다. */
async function scrapeTable(page, { metrics, index, label, maxPages }) {
  const rows = await collect(page, maxPages);
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const c = row.texts;
    if (c.length !== Object.keys(index).length && c.length < 4) {
      throw new Error(`${label}: row has ${c.length} columns`);
    }
    const kboId = playerIdOf(row.hrefs[index["선수명"]]);
    if (seen.has(kboId)) throw new Error(`${label}: duplicate playerId ${kboId}`);
    seen.add(kboId);
    const values = {};
    for (const [key, column] of Object.entries(metrics)) {
      if (!(column in index)) throw new Error(`${label}: column ${column} not found`);
      values[key] = int(c[index[column]], `${label}.${key}`);
    }
    out.push({
      kboId,
      name: c[index["선수명"]].replace(/^\*\s*/, "").trim(),
      team: c[index["팀명"]].trim(),
      values,
    });
  }
  return out;
}

async function scrapeCareer(page, url, { metrics, expectedHead, sortKey, minRows, label }) {
  await page.goto(url, { waitUntil: "networkidle" });
  await ensureSeason(page, "9999");
  await sortDescending(page, sortKey);
  const index = columnIndex(await readHead(page), expectedHead, `${label} career`);
  const rows = await scrapeTable(page, { metrics, index, label: `${label} career`, maxPages: 120 });
  if (rows.length < minRows) throw new Error(`${label} career coverage too small: ${rows.length} < ${minRows}`);
  return rows;
}

/** 2026 시즌 값을 여러 표에서 모아 kboId 하나로 합친다. */
async function scrapeSeason(page, sources, { season, label, minRows }) {
  const merged = new Map();
  for (const [url, sortKey, metrics] of sources) {
    await page.goto(url, { waitUntil: "networkidle" });
    await ensureSeason(page, season);
    // counting 정렬로 전체 명단을 여는다(위 상수 주석의 규정타석 필터 문제).
    await sortDescending(page, sortKey);
    const head = await readHead(page);
    const index = {};
    head.forEach((name, i) => { if (!(name in index)) index[name] = i; });
    for (const column of Object.values(metrics)) {
      if (!(column in index)) throw new Error(`${label} ${season} ${url}: column ${column} missing (head=${head.join(" ")})`);
    }
    const rows = await scrapeTable(page, { metrics, index, label: `${label} ${season}`, maxPages: 20 });
    if (rows.length < minRows) throw new Error(`${label} ${season} coverage too small: ${rows.length} (${url})`);
    for (const row of rows) {
      const prev = merged.get(row.kboId);
      if (!prev) { merged.set(row.kboId, row); continue; }
      if (prev.name !== row.name) throw new Error(`${label} ${season}: identity mismatch ${row.kboId}`);
      Object.assign(prev.values, row.values);
    }
  }
  return merged;
}

/** 통산 − 2026 = 2025년 말 기준선. 음수는 즉시 실패(정렬·행 어긋남의 증거). */
function subtract(careerRows, seasonById, metricKeys, label) {
  return careerRows.map((career) => {
    const current = seasonById.get(career.kboId);
    if (current && current.name !== career.name) {
      throw new Error(`${label}: identity mismatch ${career.kboId} (${career.name} vs ${current.name})`);
    }
    const values = {};
    for (const key of metricKeys) {
      const total = career.values[key];
      const now = current?.values?.[key] ?? 0;
      const baseline = total - now;
      if (!Number.isInteger(baseline) || baseline < 0) {
        throw new Error(`${label}: baseline subtraction invalid ${career.kboId}.${key} (${total} - ${now})`);
      }
      values[key] = baseline;
    }
    return { kboId: career.kboId, name: career.name, team: career.team, values };
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    const hitterCareer = await scrapeCareer(page, HITTER_CAREER_URL, {
      metrics: HITTER_METRICS, expectedHead: HITTER_CAREER_HEAD,
      sortKey: "HIT_CN", minRows: 2000, label: "hitter",
    });
    const hitterSeason = await scrapeSeason(page, HITTER_SEASON_SOURCES, {
      season: "2026", label: "hitter", minRows: 250,
    });

    const pitcherCareer = await scrapeCareer(page, PITCHER_CAREER_URL, {
      metrics: PITCHER_METRICS, expectedHead: PITCHER_CAREER_HEAD,
      sortKey: "KK_CN", minRows: 1500, label: "pitcher",
    });
    const pitcherSeason = await scrapeSeason(page, PITCHER_SEASON_SOURCES, {
      season: "2026", label: "pitcher", minRows: 200,
    });

    const payload = {
      schemaVersion: 1,
      throughSeason: 2025,
      source: {
        hitterUrl: HITTER_CAREER_URL,
        pitcherUrl: PITCHER_CAREER_URL,
        seasonValue: "9999",
        currentSeason: 2026,
        capturedAt: new Date().toISOString(),
      },
      metrics: {
        batter: Object.keys(HITTER_METRICS),
        pitcher: Object.keys(PITCHER_METRICS),
      },
      batter: subtract(hitterCareer, hitterSeason, Object.keys(HITTER_METRICS), "hitter"),
      pitcher: subtract(pitcherCareer, pitcherSeason, Object.keys(PITCHER_METRICS), "pitcher"),
    };
    payload.rowCount = { batter: payload.batter.length, pitcher: payload.pitcher.length };
    payload.sha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");

    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`wrote batter=${payload.batter.length} pitcher=${payload.pitcher.length} -> ${OUTPUT}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
