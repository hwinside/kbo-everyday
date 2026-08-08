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

/* ── 행 불안정 원장 ─────────────────────────────────────────────
 *
 * ⚠︎ 이걸 안 읽으면 **이 PR 이 고치려던 정체가 그대로 재현된다**(삼순 P0).
 * 크롤 내부 promote 경로는 payload 로 원장을 받지만, updater 가 PR 직전에 부르는
 * 이 **독립 verifier** 는 별도 프로세스다. 여기서 `rowLedger` 를 안 넘기면
 * `ledgerKeys = ∅` 이라 행 면제도 digest 정규화도 통째로 꺼진다.
 *
 * ⚠︎ 파일이 없으면 **fail-close** 다. "없으면 빈 원장으로 진행"으로 두면
 * 원장 배선이 끊어져도 게이트가 조용히 종전 동작로 돌아가고, 그건 아무도 못 잡는다.
 * (원장이 비어있는 건 정상이다 — 흔든 행이 없는 날. 없는 것과 비어있는 건 다르다.) */
const ROW_LEDGER_PATH = `${CONSTANTS}/stats-${SEASON}-defense-row-ledger.json`;
let rowLedger;
try {
  rowLedger = J(ROW_LEDGER_PATH);
} catch (error) {
  console.error(
    `\n❌ row_ledger_missing: ${ROW_LEDGER_PATH} 를 읽지 못했다 — ${error?.message ?? error}`
      + "\n   원장 없이 대조하면 원본 행 불안정 면제가 꺼져 거짓 불일치로 정체한다(fail-close).",
  );
  process.exit(1);
}

const failures = [];

// ⚠︎ 대조 대상·판정은 크롤러와 **같은 함수**(assertSourceTruth)를 쓴다.
// 종전에는 이 파일이 자체 spec 목록을 들고 있어서, 라이브러리에 Runner(sb/cs) 대조를
// 추가해도 여기에는 반영되지 않는 이중 계약이 생겼다.
const browser = await chromium.launch();
try {
  // 파생 입력도 넘긴다 — 이건 선택사항이 아니다.
  // 종전에는 여기서 빼고 아래에서 `crossCheckDerived` 를 따로 불렀는데,
  // 그러면 ①파생 검증이 두 곳으로 갈라지고 ②라이브러리가 파생 검증을 강제하는
  // 계약(derived_inputs_missing)과 충돌한다. 크롤러와 동일한 호출로 맞춘다.
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
    // 크롤 내부 promote 경로와 **같은 입력**을 넘긴다.
    // 이게 빠지면 두 경로가 서로 다른 계약을 가져 한쪽만 고친 꼴이 된다.
    rowLedger,
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
