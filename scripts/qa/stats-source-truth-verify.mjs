/**
 * 스탯 원본 정합성 fail-close 게이트 (독립 검증기).
 *
 * 크롤러(scripts/crawl-stats.mjs)는 write 직전에 같은 계약을 실행한다.
 * 이 스크립트는 *이미 저장된 스냅샷*을 대상으로 같은 대조를 돌려,
 * 크롤 경로를 우회해 들어온 데이터(수동 편집·머지·백필)도 잡는다.
 *
 * 배경(2026-08-04): 종전 게이트는 행 개수·누락 델타(≤10)와 identity/shape만 봤다.
 * ①곽빈 ERA를 99.99로 오염시켜도 전 게이트가 GREEN, ②타자 병합키가 `${name}|${team}`
 * 이라 같은 팀 동명이인(키움 이주형 50167/51302)이 서로를 덮어써 1명이 사라져도 통과.
 *
 * 사용:
 *   node scripts/qa/stats-source-truth-verify.mjs [--season 2026]
 *
 * 네트워크가 필요하다. KBO 접근이 막히면 SKIP이 아니라 FAIL이다
 * (검증 불가를 통과로 취급하면 게이트가 아니다).
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { assertSourceTruth } from "../lib/stats-source-truth.mjs";

const SEASON = process.argv.includes("--season")
  ? process.argv[process.argv.indexOf("--season") + 1]
  : "2026";
const KBO_BASE = "https://www.koreabaseball.com";
const CONSTANTS = "src/lib/constants";
const J = (path) => JSON.parse(readFileSync(path, "utf8"));

const batters = J(`${CONSTANTS}/stats-${SEASON}-batters.json`);
const pitchers = J(`${CONSTANTS}/stats-${SEASON}-pitchers.json`);
const defense = J(`${CONSTANTS}/stats-${SEASON}-defense.json`);
const defenseRuns = J(`${CONSTANTS}/player-defense-runs.json`);
const roster = J(`${CONSTANTS}/players-roster.json`);
const foreignIdSource = readFileSync(`${CONSTANTS}/foreign-id-map.ts`, "utf8");

const failures = [];

// ⚠︎ 대조 대상·판정은 크롤러와 **같은 함수**(assertSourceTruth)를 쓴다.
// 종전에는 이 파일이 자체 spec 목록을 들고 있어서, 라이브러리에 Runner(sb/cs) 대조를
// 추가해도 여기에는 반영되지 않는 이중 계약이 생겼다.
const browser = await chromium.launch();
try {
  // 파생 입력도 같은 함수에 넘긴다 — `assertSourceTruth` 안에서 파생 교차결속까지 끝난다.
  // 종전에는 여기서만 따로 `crossCheckDerived` 를 불렀는데, 그 구조 때문에
  // "파생 검증을 끄는 optional flag" 가 필요해졌고 그 flag 가 곧 우회 스위치가 됐다.
  await assertSourceTruth({
    browser,
    kboBase: KBO_BASE,
    season: SEASON,
    batters,
    pitchers,
    defense,
    defenseRuns,
    roster,
    foreignIdSource,
    log: (line) => console.log(line.replace(/^ {4}/, "  ")),
  });
} catch (error) {
  failures.push(String(error?.message ?? error));
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n❌ 원본 정합성 FAIL — ${failures.length}건`);
  for (const line of failures.slice(0, 40)) console.error("  - " + line);
  if (failures.length > 40) console.error(`  ... 외 ${failures.length - 40}건`);
  process.exit(1);
}
console.log("\n✅ stats source truth: 전 행·전 필드 원본 일치, 파생 교차결속 PASS");
