#!/usr/bin/env node
/**
 * 로스터 생년월일 백필 (일회성 + 재실행 안전)
 *
 * players-roster.json 각 선수의 KBO 선수 상세 페이지를 방문해
 * 생년월일(#...playerProfile_lblBirthday)을 긁어 `birthDate`(ISO)로 채운다.
 *
 * - 로스터 membership/순서는 건드리지 않음 — `birthDate` 필드만 추가/갱신.
 * - 이미 birthDate 있는 선수는 skip (재실행 시 이어서).
 * - 외국인(FP/AQ)은 foreign-id-map 역매핑으로 숫자 상세 ID 확보, 없으면 null 유지.
 * - 상시 크롤(crawl-roster-v2)이 birthDate를 보존/보강하므로, 이 스크립트는 초기 채움용.
 */

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONSTANTS_DIR = join(__dirname, "..", "src/lib/constants");
const ROSTER_PATH = join(CONSTANTS_DIR, "players-roster.json");

const CONCURRENCY = Number(process.env.BIRTH_CONCURRENCY || 4);

// "2000년 07월 12일" -> "2000-07-12"
function parseKboBirthday(text) {
  const m = /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/.exec(text || "");
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const BIRTH_SEL = "#cphContents_cphContents_cphContents_playerProfile_lblBirthday";

async function fetchBirth(page, detailId, position) {
  const urls = position === "투수"
    ? [
        `https://www.koreabaseball.com/Record/Player/PitcherDetail/Basic.aspx?playerId=${detailId}`,
        `https://www.koreabaseball.com/Record/Player/HitterDetail/Basic.aspx?playerId=${detailId}`,
      ]
    : [
        `https://www.koreabaseball.com/Record/Player/HitterDetail/Basic.aspx?playerId=${detailId}`,
        `https://www.koreabaseball.com/Record/Player/PitcherDetail/Basic.aspx?playerId=${detailId}`,
      ];
  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      const txt = await page.$eval(BIRTH_SEL, (el) => el.textContent.trim()).catch(() => "");
      const iso = parseKboBirthday(txt);
      if (iso) return iso;
    } catch { /* try next url */ }
  }
  return null;
}

async function main() {
  const roster = JSON.parse(readFileSync(ROSTER_PATH, "utf-8"));

  // 외국인 alpha(FP/AQ) -> 숫자 상세 ID 역매핑
  const foreignSrc = readFileSync(join(CONSTANTS_DIR, "foreign-id-map.ts"), "utf-8");
  const ALPHA_TO_NUMERIC = {};
  for (const m of foreignSrc.matchAll(/"(\d+)":\s*"((?:FP|AQ)\d+)"/g)) {
    ALPHA_TO_NUMERIC[m[2]] = m[1];
  }

  const detailIdFor = (p) => {
    if (/^\d+$/.test(p.kboId)) return p.kboId;
    return ALPHA_TO_NUMERIC[p.kboId] || null;
  };

  const todo = roster.filter((p) => !p.birthDate && detailIdFor(p));
  const noDetail = roster.filter((p) => !p.birthDate && !detailIdFor(p));
  console.log(`대상 ${todo.length}명 (상세ID 없음 skip ${noDetail.length}명, 이미보유 ${roster.length - todo.length - noDetail.length}명)`);

  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  let done = 0, filled = 0, failed = 0;
  let sinceSave = 0;

  const save = () => {
    writeFileSync(ROSTER_PATH, JSON.stringify(roster, null, 2) + "\n");
  };

  // 워커 풀: 각 워커가 자기 page로 순차 처리
  let idx = 0;
  async function worker() {
    const page = await browser.newPage();
    while (true) {
      const p = todo[idx++];
      if (!p) break;
      const iso = await fetchBirth(page, detailIdFor(p), p.position);
      if (iso) { p.birthDate = iso; filled++; }
      else { p.birthDate = p.birthDate ?? null; failed++; }
      done++; sinceSave++;
      if (sinceSave >= 25) { save(); sinceSave = 0; }
      if (done % 50 === 0) console.log(`  진행 ${done}/${todo.length} (fill=${filled}, fail=${failed})`);
    }
    await page.close();
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // 상세ID 없는 선수도 키는 존재하도록 null 세팅 (TS 타입 일관 string|null)
  for (const p of roster) if (p.birthDate === undefined) p.birthDate = null;
  save();
  await browser.close();
  console.log(`\n✅ 백필 완료: 성공 ${filled}, 실패 ${failed}, 상세ID없음 ${noDetail.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
