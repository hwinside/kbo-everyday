/**
 * roster 크롤 완주 계약 스모크.
 *
 * 이 게이트의 존재 이유: 부분 수집이 조용히 정상 완주로 저장되던 결손 때문에
 * `②-b roster/사진/inventory 자동머지 보류` 가드가 걸려 있었고, roster 는 거의 매일
 * 바뀌므로 자동머지가 구조적으로 멈춰 데이터가 stale 됐다.
 *
 * 검증 대상은 *값*이 아니라 *불변식*이다. 실제 선수 수가 바뀌어도 RED 가 되지 않고,
 * 완주 판정 로직이 무너지면 RED 가 된다.
 *
 * 각 케이스는 "이 판정이 없으면 어떤 사고가 통과하는가" 를 주석에 남긴다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEAM_MIN_PLAYERS,
  TEAM_MAX_DROP_RATIO,
  TEAM_FAIL_REASONS,
  buildTeamBaseline,
  evaluateTeamCollection,
  evaluateRosterCompletion,
  formatCompletionFailure,
} from "../lib/roster-crawl-completion.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "../..");

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.error(`  ✗ ${name}\n      ${e.message}`);
  }
}

console.log("\n§1 팀 단위 판정 — 실패 사유가 구분되어야 한다");

// 없으면: 셀렉트가 안 바뀐 채 직전 팀 표를 긁어 A팀 선수가 B팀으로 저장된다(정체성 오염).
check("셀렉트 미확정이면 수집 수가 충분해도 실패", () => {
  const r = evaluateTeamCollection({ selectConfirmed: false, collected: 500, baseline: 80 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, TEAM_FAIL_REASONS.SELECT_UNCONFIRMED);
});

// 없으면: 팀이 통째로 사라진 roster 가 정상 저장된다.
check("수집 0명은 실패", () => {
  const r = evaluateTeamCollection({ selectConfirmed: true, collected: 0, baseline: 80 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, TEAM_FAIL_REASONS.EMPTY);
});

// 없으면: 첫 페이지만 긁고 페이저가 끊긴 부분 수집이 통과한다.
check("최소 인원 미만은 실패", () => {
  const r = evaluateTeamCollection({
    selectConfirmed: true,
    collected: TEAM_MIN_PLAYERS - 1,
    baseline: undefined,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, TEAM_FAIL_REASONS.BELOW_FLOOR);
});

// 없으면: 80명이던 팀이 20명으로 급락해도 "최소 인원은 넘었으니" 통과한다.
check("baseline 대비 급락은 실패", () => {
  const r = evaluateTeamCollection({ selectConfirmed: true, collected: 20, baseline: 80 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, TEAM_FAIL_REASONS.DROP);
});

// 정상 운영을 막으면 안 된다 — 콜업·말소 수준의 변동은 통과해야 한다.
check("허용 범위 내 감소는 통과", () => {
  const baseline = 80;
  const allowed = Math.floor(baseline * (1 - TEAM_MAX_DROP_RATIO));
  const r = evaluateTeamCollection({ selectConfirmed: true, collected: allowed, baseline });
  assert.equal(r.ok, true, r.detail);
});

check("증가는 통과", () => {
  const r = evaluateTeamCollection({ selectConfirmed: true, collected: 95, baseline: 80 });
  assert.equal(r.ok, true, r.detail);
});

// baseline 이 없는 첫 실행에서 drop 판정이 걸리면 영원히 부트스트랩이 안 된다.
check("baseline 없으면 drop 판정을 적용하지 않는다", () => {
  const r = evaluateTeamCollection({ selectConfirmed: true, collected: 30, baseline: undefined });
  assert.equal(r.ok, true, r.detail);
});

console.log("\n§2 완주 판정 — 한 슬롯이라도 비면 완주가 아니다");

const okOutcome = (teamName, phase) => ({
  teamName,
  phase,
  attempts: 1,
  result: { ok: true, reason: null, detail: "수집 80명" },
});

check("전 슬롯 성공이면 완주", () => {
  const outcomes = [];
  for (const phase of ["batters", "pitchers"]) {
    for (let i = 0; i < 10; i++) outcomes.push(okOutcome(`T${i}`, phase));
  }
  const e = evaluateRosterCompletion(outcomes, 20);
  assert.equal(e.complete, true, e.summary);
});

// 없으면: 9팀만 돌고 끝난 런이 완주로 저장된다.
check("슬롯이 모자라면 미완주", () => {
  const outcomes = [];
  for (const phase of ["batters", "pitchers"]) {
    for (let i = 0; i < 9; i++) outcomes.push(okOutcome(`T${i}`, phase));
  }
  const e = evaluateRosterCompletion(outcomes, 20);
  assert.equal(e.complete, false);
  assert.equal(e.missingSlots, 2);
});

check("한 팀 실패면 나머지가 전부 성공이어도 미완주", () => {
  const outcomes = [];
  for (const phase of ["batters", "pitchers"]) {
    for (let i = 0; i < 10; i++) outcomes.push(okOutcome(`T${i}`, phase));
  }
  outcomes[3] = {
    teamName: "T3",
    phase: "batters",
    attempts: 3,
    result: { ok: false, reason: TEAM_FAIL_REASONS.EMPTY, detail: "수집 0명" },
  };
  const e = evaluateRosterCompletion(outcomes, 20);
  assert.equal(e.complete, false);
  assert.equal(e.failures.length, 1);
});

check("실패 리포트에 팀·사유·시도횟수가 남는다", () => {
  const e = evaluateRosterCompletion(
    [
      {
        teamName: "두산",
        phase: "batters",
        attempts: 3,
        result: { ok: false, reason: TEAM_FAIL_REASONS.EMPTY, detail: "수집 0명" },
      },
    ],
    20
  );
  const text = formatCompletionFailure(e);
  assert.match(text, /roster_crawl_incomplete/);
  assert.match(text, /두산/);
  assert.match(text, /empty/);
  assert.match(text, /시도 3회/);
});

console.log("\n§3 baseline 산출");

check("teamId별로 집계하고 teamId 없는 행은 무시", () => {
  const b = buildTeamBaseline([
    { teamId: 1 }, { teamId: 1 }, { teamId: 2 }, { teamId: null }, {},
  ]);
  assert.equal(b.get(1), 2);
  assert.equal(b.get(2), 1);
  assert.equal(b.size, 2);
});

console.log("\n§4 프로덕션 배선 — 크롤러가 실제로 이 계약을 태우는가");

const crawlerSrc = readFileSync(join(PROJECT_ROOT, "scripts/crawl-roster-v2.mjs"), "utf-8");

// 없으면: 계약 모듈은 통과하는데 크롤러는 옛 경로로 그냥 저장한다(false-green).
check("크롤러가 완주 계약 모듈을 import 한다", () => {
  assert.match(crawlerSrc, /from "\.\/lib\/roster-crawl-completion\.mjs"/);
});

check("크롤러가 evaluateRosterCompletion 결과로 fail-close 한다", () => {
  assert.match(crawlerSrc, /evaluateRosterCompletion\(/);
  assert.match(
    crawlerSrc,
    /if \(!completion\.complete\)[\s\S]{0,200}process\.exit\(1\)/,
    "미완주면 process.exit(1) 로 끝나야 한다"
  );
});

// 없으면: 미완주인데도 writeFileSync 가 먼저 실행돼 오염 데이터가 저장된다.
check("fail-close 가 저장(writeFileSync)보다 앞선다", () => {
  const failIdx = crawlerSrc.indexOf("evaluateRosterCompletion(");
  const writeIdx = crawlerSrc.indexOf("writeFileSync(join(CONSTANTS_DIR");
  assert.ok(failIdx > 0, "완주 판정이 없다");
  assert.ok(writeIdx > 0, "저장 호출을 찾지 못했다");
  assert.ok(failIdx < writeIdx, "완주 판정이 저장보다 뒤에 있다 — 오염 데이터가 저장된다");
});

// 없으면: 셀렉트 timeout 을 흘려보내던 옛 동작이 남아 직전 팀 표를 긁는다.
check("changeSelectAndWait 가 셀렉트 확정 여부를 반환한다", () => {
  assert.match(
    crawlerSrc,
    /const settled = await page\.\$eval\(selector[\s\S]{0,120}return settled === value;/,
    "셀렉트 최종값을 재확인해 boolean 으로 돌려줘야 한다"
  );
});

check("팀 수집이 bounded retry 를 태운다", () => {
  assert.match(crawlerSrc, /maxAttempts/, "재시도 상한이 없다");
  assert.match(crawlerSrc, /collectTeamWithContract\(/);
});

// 없으면: 판정 실패한 시도의 행이 이미 반영돼 되돌릴 수 없다.
check("판정 ok 일 때만 행을 반영한다", () => {
  assert.match(
    crawlerSrc,
    /if \(result\.ok\) \{\s*\n\s*applyRows\(/,
    "applyRows 는 result.ok 분기 안에서만 호출돼야 한다"
  );
});

console.log(`\nPASS=${pass} FAIL=${failures.length}`);
if (failures.length > 0) {
  console.error("\n❌ roster 완주 계약 스모크 실패");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("✅ roster 크롤 완주 계약 스모크 통과");
