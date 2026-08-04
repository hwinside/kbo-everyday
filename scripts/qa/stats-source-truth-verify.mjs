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
import {
  BATTER_BASIC1_COLUMNS,
  BATTER_BASIC2_COLUMNS,
  DEFENSE_COLUMNS,
  PITCHER_COLUMNS,
  collectKboDefensePages,
  collectKboPages,
  crossCheckDataset,
  crossCheckDerived,
} from "../lib/stats-source-truth.mjs";

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

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const specs = [
    {
      label: "투수",
      rows: pitchers,
      url: `${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx?sort=GAME_CN`,
      columns: PITCHER_COLUMNS,
    },
    {
      label: "타자",
      rows: batters,
      url: `${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx?sort=GAME_CN`,
      columns: BATTER_BASIC1_COLUMNS,
    },
    {
      label: "타자(추가지표)",
      rows: batters,
      url: `${KBO_BASE}/Record/Player/HitterBasic/Basic2.aspx?sort=GAME_CN`,
      columns: BATTER_BASIC2_COLUMNS,
    },
  ];
  for (const spec of specs) {
    const kbo = await collectKboPages(page, spec.url, SEASON);
    const result = crossCheckDataset({
      label: spec.label,
      rows: spec.rows,
      kbo,
      columns: spec.columns,
    });
    console.log(
      `  [${spec.label}] 우리 ${result.ourRows}행 / KBO ${result.kboRows}행 · ${result.cells}셀 대조`,
    );
    failures.push(...result.failures);
  }

  // 수비는 `(playerId, pos)` 복합키다 — 한 선수가 여러 포지션을 본다(현재 163명).
  // 종전에는 수비에 스냅샷 가드도 원본 대조도 없어서 823행 → 30행으로 무너져도 조용히 배포됐다.
  const kboDefense = await collectKboDefensePages(
    page,
    `${KBO_BASE}/Record/Player/Defense/Basic.aspx?sort=GAME_CN`,
    SEASON,
  );
  const defenseResult = crossCheckDataset({
    label: "수비",
    rows: defense,
    kbo: kboDefense,
    columns: DEFENSE_COLUMNS,
    keyOf: (row) => `${String(row.kboId ?? "").trim()}|${row.pos ?? ""}`,
  });
  console.log(
    `  [수비] 우리 ${defenseResult.ourRows}행 / KBO ${defenseResult.kboRows}행 · ${defenseResult.cells}셀 대조`,
  );
  failures.push(...defenseResult.failures);
} finally {
  await browser.close();
}

failures.push(
  ...crossCheckDerived({ batters, pitchers, defense, defenseRuns, roster, foreignIdSource }),
);

if (failures.length) {
  console.error(`\n❌ 원본 정합성 FAIL — ${failures.length}건`);
  for (const line of failures.slice(0, 40)) console.error("  - " + line);
  if (failures.length > 40) console.error(`  ... 외 ${failures.length - 40}건`);
  process.exit(1);
}
console.log("\n✅ stats source truth: 전 행·전 필드 원본 일치, 파생 교차결속 PASS");
