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
 * ── 2026-08-06 삼순 NO-GO 3건 반영 ─────────────────────────────
 * ① baseline 축: §5 가 **실제 저장본**으로 "정상 데이터가 통과하는가"를 검증한다.
 *    이전 판은 전체 roster 를 타자 phase 와 비교해 actual crawl 이 영구 RED 였는데,
 *    스모크가 합성 fixture 만 봐서 그걸 놓쳤다.
 * ② 팀명 witness: 셀렉트 값이 맞아도 표가 직전 팀이면 RED.
 * ③ quiet EOF / 중복 ID / 독립 재조회 집합 안정성.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEAM_MIN_PLAYERS,
  TEAM_MAX_DROP_RATIO,
  TEAM_FAIL_REASONS,
  buildPhaseBaseline,
  classifyEndRequest,
  evaluateTeamCollection,
  evaluateSetStability,
  evaluateRosterCompletion,
  buildSlotKey,
  buildExpectedSlotKeys,
  phaseFiltersTrusted,
  formatCompletionFailure,
} from "../lib/roster-crawl-completion.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "../..");
const CONSTANTS = join(PROJECT_ROOT, "src/lib/constants");

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

/** 판정 통과 기본형 — 각 테스트는 깨뜨릴 축 하나만 바꾼다. */
const okInput = (over = {}) => ({
  selectConfirmed: true,
  requestedTeamName: "LG",
  observedTeamNames: Array(30).fill("LG"),
  collected: 30,
  uniqueIds: 30,
  pagerComplete: true,
  baseline: 30,
  ...over,
});

console.log("\n§1 팀 단위 판정 — 실패 사유가 구분되어야 한다");

// 없으면: 셀렉트가 안 바뀐 채 직전 팀 표를 긁는다.
check("셀렉트 미확정이면 실패", () => {
  const r = evaluateTeamCollection(okInput({ selectConfirmed: false }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, TEAM_FAIL_REASONS.SELECT_UNCONFIRMED);
});

// 삼순 NO-GO ②. 없으면: select 값만 바뀌고 표는 직전 팀인 상태가 통과 → 정체성 오염.
check("표에 다른 팀이 섞여 있으면 실패 (팀명 witness)", () => {
  const names = Array(30).fill("LG");
  names[7] = "두산";
  const r = evaluateTeamCollection(okInput({ observedTeamNames: names }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, TEAM_FAIL_REASONS.WRONG_TEAM);
  assert.match(r.detail, /두산/);
});

check("표 전체가 다른 팀이면 실패", () => {
  const r = evaluateTeamCollection(okInput({ observedTeamNames: Array(30).fill("두산") }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, TEAM_FAIL_REASONS.WRONG_TEAM);
});

// 없으면: witness 를 못 읽는 상태를 "이의 없음"으로 오해해 통과시킨다.
check("팀명을 읽지 못하면 통과시키지 않는다", () => {
  const r = evaluateTeamCollection(okInput({ observedTeamNames: Array(30).fill("") }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, TEAM_FAIL_REASONS.WRONG_TEAM);
});

// 삼순 NO-GO ③. 없으면: 3페이지 중 1페이지만 긁고 정상 완주로 저장.
check("페이저 미완주면 실패 (quiet EOF)", () => {
  const r = evaluateTeamCollection(okInput({ pagerComplete: false }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, TEAM_FAIL_REASONS.PAGER_INCOMPLETE);
});

check("pagerComplete 가 boolean true 가 아니면 실패", () => {
  for (const v of [undefined, null, "true", 1]) {
    const r = evaluateTeamCollection(okInput({ pagerComplete: v }));
    assert.equal(r.ok, false, `pagerComplete=${JSON.stringify(v)} 가 통과했다`);
  }
});

// 삼순 NO-GO ③. 없으면: 같은 페이지를 반복 수집해 인원수만 채운 결과가 통과.
check("중복 playerId 가 있으면 실패", () => {
  const r = evaluateTeamCollection(okInput({ collected: 30, uniqueIds: 24 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, TEAM_FAIL_REASONS.DUPLICATE_IDS);
});

// 없으면: 팀이 통째로 사라진 roster 가 정상 저장된다.
check("수집 0명은 실패", () => {
  const r = evaluateTeamCollection(okInput({ collected: 0, uniqueIds: 0, observedTeamNames: [] }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, TEAM_FAIL_REASONS.EMPTY);
});

// 없으면: 첫 페이지 일부만 긁힌 부분 수집이 통과한다.
check("최소 인원 미만은 실패", () => {
  const n = TEAM_MIN_PLAYERS - 1;
  const r = evaluateTeamCollection(
    okInput({ collected: n, uniqueIds: n, observedTeamNames: Array(n).fill("LG"), baseline: undefined })
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, TEAM_FAIL_REASONS.BELOW_FLOOR);
});

// 없으면: 37명이던 팀이 20명으로 급락해도 floor 만 넘으면 통과한다.
check("직전 저장본 대비 급락은 실패", () => {
  const r = evaluateTeamCollection(
    okInput({ collected: 20, uniqueIds: 20, observedTeamNames: Array(20).fill("LG"), baseline: 37 })
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, TEAM_FAIL_REASONS.DROP);
});

console.log("\n§2 정상 운영은 막지 않는다 (false-RED 방지)");

check("정상 수집은 통과", () => {
  const r = evaluateTeamCollection(okInput());
  assert.equal(r.ok, true, r.detail);
});

check("허용 범위 내 감소는 통과 (콜업·말소)", () => {
  const baseline = 30;
  const allowed = Math.floor(baseline * (1 - TEAM_MAX_DROP_RATIO));
  const r = evaluateTeamCollection(
    okInput({ collected: allowed, uniqueIds: allowed, observedTeamNames: Array(allowed).fill("LG"), baseline })
  );
  assert.equal(r.ok, true, r.detail);
});

check("증가는 통과", () => {
  const r = evaluateTeamCollection(
    okInput({ collected: 44, uniqueIds: 44, observedTeamNames: Array(44).fill("LG"), baseline: 30 })
  );
  assert.equal(r.ok, true, r.detail);
});

// baseline 이 없는 첫 실행에서 drop 판정이 걸리면 영원히 부트스트랩이 안 된다.
check("baseline 없으면 drop 판정을 적용하지 않는다", () => {
  const r = evaluateTeamCollection(
    okInput({ collected: 20, uniqueIds: 20, observedTeamNames: Array(20).fill("LG"), baseline: undefined })
  );
  assert.equal(r.ok, true, r.detail);
});

console.log("\n§3 독립 재조회 집합 안정성 (#1103 flapping)");

check("동일 집합이면 통과", () => {
  const r = evaluateSetStability(["1", "2", "3"], ["3", "2", "1"]);
  assert.equal(r.ok, true, r.detail);
});

// 없으면: 조회마다 흔들리는 판독이 정상 완주로 저장된다.
check("집합이 다르면 unstable", () => {
  const r = evaluateSetStability(["1", "2", "3"], ["1", "2"]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, TEAM_FAIL_REASONS.UNSTABLE);
  assert.match(r.detail, /3/);
});

check("한쪽에만 있는 ID 도 unstable", () => {
  const r = evaluateSetStability(["1", "2"], ["1", "2", "9"]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, TEAM_FAIL_REASONS.UNSTABLE);
});

console.log("\n§4 완주 판정 — 한 슬롯이라도 비면 완주가 아니다");

const okOutcome = (teamId, phase) => ({
  teamName: `T${teamId}`,
  teamId,
  phase,
  attempts: 1,
  result: { ok: true, reason: null, detail: "수집 30명" },
});

// 슬롯 key 가 phase×teamId 로 만들어지므로, 테스트도 teamId 10개(1..10)로 예상 집합을 세운다.
const TEST_TEAM_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const EXPECTED_KEYS = buildExpectedSlotKeys(TEST_TEAM_IDS);

check("전 슬롯 성공이면 완주", () => {
  const outcomes = [];
  for (const phase of ["batters", "pitchers"]) {
    for (const id of TEST_TEAM_IDS) outcomes.push(okOutcome(id, phase));
  }
  assert.equal(evaluateRosterCompletion(outcomes, EXPECTED_KEYS).complete, true);
});

// 없으면: 9팀만 돌고 끝난 런이 완주로 저장된다.
check("슬롯이 모자라면 미완주", () => {
  const outcomes = [];
  for (const phase of ["batters", "pitchers"]) {
    for (const id of TEST_TEAM_IDS.slice(0, 9)) outcomes.push(okOutcome(id, phase));
  }
  const e = evaluateRosterCompletion(outcomes, EXPECTED_KEYS);
  assert.equal(e.complete, false);
  assert.equal(e.missingSlots, 2);
  assert.deepEqual(e.missingKeys.sort(), [buildSlotKey("batters", 10), buildSlotKey("pitchers", 10)].sort());
});

check("한 팀 실패면 나머지가 전부 성공이어도 미완주", () => {
  const outcomes = [];
  for (const phase of ["batters", "pitchers"]) {
    for (const id of TEST_TEAM_IDS) outcomes.push(okOutcome(id, phase));
  }
  outcomes[3] = {
    teamName: "T4",
    teamId: 4,
    phase: "batters",
    attempts: 3,
    result: { ok: false, reason: TEAM_FAIL_REASONS.EMPTY, detail: "수집 0명" },
  };
  const e = evaluateRosterCompletion(outcomes, EXPECTED_KEYS);
  assert.equal(e.complete, false);
  assert.equal(e.failures.length, 1);
});

// 삼순 NO-GO ② 핵심: 중복 슬롯 1개가 누락 슬롯을 메꿐어 length 는 맞지만 실제로는 한 팀이 빠졌다.
// 없으면: 개수만 보는 판이 이걸 complete=true 로 샜다.
check("중복 슬롯이 누락 슬롯을 메꿐어도 — count 는 맞지만 미완주", () => {
  const outcomes = [];
  for (const phase of ["batters", "pitchers"]) {
    for (const id of TEST_TEAM_IDS) outcomes.push(okOutcome(id, phase));
  }
  // batters T10 슬롯을 batters T1 중복으로 교체 → 개수는 그대로 20, 그러나 T10 batters 누락.
  const dupIdx = outcomes.findIndex((o) => o.phase === "batters" && o.teamId === 10);
  outcomes[dupIdx] = okOutcome(1, "batters");
  const e = evaluateRosterCompletion(outcomes, EXPECTED_KEYS);
  assert.equal(outcomes.length, EXPECTED_KEYS.length, "count 는 동일해야 함정(개수-only 판은 이걸 놓칩다)");
  assert.equal(e.complete, false);
  assert.deepEqual(e.duplicateKeys, [buildSlotKey("batters", 1)]);
  assert.deepEqual(e.missingKeys, [buildSlotKey("batters", 10)]);
});

// 순수 중복(누락 없이 중복만) — duplicateKeys 검사가 **단독 검출자**인 케이스.
// 이 테스트가 없으면 duplicateKeys 체크를 지워도 중복+누락 케이스를 missingKeys 가 대신 잡아 GREEN 이 된다.
check("누락 없는 순수 중복도 미완주 (duplicateKeys 단독 검출)", () => {
  const outcomes = [];
  for (const phase of ["batters", "pitchers"]) {
    for (const id of TEST_TEAM_IDS) outcomes.push(okOutcome(id, phase));
  }
  // 전 슬롯 그대로 두고 batters T1 을 하나 더 밀어넣는다 → 누락 0, 중복 1, length=21.
  outcomes.push(okOutcome(1, "batters"));
  const e = evaluateRosterCompletion(outcomes, EXPECTED_KEYS);
  assert.equal(e.missingKeys.length, 0, "누락은 없어야 한다(그래야 duplicateKeys 가 단독 검출자다)");
  assert.equal(e.complete, false);
  assert.deepEqual(e.duplicateKeys, [buildSlotKey("batters", 1)]);
});

// 예상밖 슬롯(잘못된 teamId/phase)도 fail-close.
check("예상밖 슬롯은 미완주", () => {
  const outcomes = [];
  for (const phase of ["batters", "pitchers"]) {
    for (const id of TEST_TEAM_IDS) outcomes.push(okOutcome(id, phase));
  }
  outcomes.push(okOutcome(999, "batters")); // 존재하지 않는 팀
  const e = evaluateRosterCompletion(outcomes, EXPECTED_KEYS);
  assert.equal(e.complete, false);
  assert.deepEqual(e.unexpectedKeys, [buildSlotKey("batters", 999)]);
});

// teamId 가 없는 outcome 은 undefined key 로 떨어져 fail-close(방어).
check("teamId 누락 outcome 은 fail-close", () => {
  const outcomes = [];
  for (const phase of ["batters", "pitchers"]) {
    for (const id of TEST_TEAM_IDS) outcomes.push(okOutcome(id, phase));
  }
  const idx = outcomes.findIndex((o) => o.phase === "batters" && o.teamId === 5);
  outcomes[idx] = { teamName: "T5", phase: "batters", attempts: 1, result: { ok: true, reason: null, detail: "x" } };
  const e = evaluateRosterCompletion(outcomes, EXPECTED_KEYS);
  assert.equal(e.complete, false);
});

check("실패 리포트에 팀·사유·시도횟수가 남는다", () => {
  const e = evaluateRosterCompletion(
    [
      {
        teamName: "두산",
        teamId: 2,
        phase: "batters",
        attempts: 3,
        result: { ok: false, reason: TEAM_FAIL_REASONS.EMPTY, detail: "수집 0명" },
      },
    ],
    [buildSlotKey("batters", 2)]
  );
  const text = formatCompletionFailure(e);
  assert.match(text, /roster_crawl_incomplete/);
  assert.match(text, /두산/);
  assert.match(text, /empty/);
  assert.match(text, /시도 3회/);
});

console.log("\n② series/season 전이 fail-close (삼순 NO-GO ①)");

// phaseFiltersTrusted 행동 계약 — season 전이 반환을 무시하면 이전 연도 표가 통과한다.
check("series·season 모두 확정이면 신뢰", () => {
  assert.equal(phaseFiltersTrusted({ hasSeries: true, seriesConfirmed: true, seasonConfirmed: true }), true);
});
check("series 전이 실패면 불신뢰", () => {
  assert.equal(phaseFiltersTrusted({ hasSeries: true, seriesConfirmed: false, seasonConfirmed: true }), false);
});
// 이게 정확히 삼순 NO-GO ① — season 전이 실패를 무시하던 결함.
check("season 전이 실패면 불신뢰(이전 연도 표 차단)", () => {
  assert.equal(phaseFiltersTrusted({ hasSeries: true, seriesConfirmed: true, seasonConfirmed: false }), false);
});
check("season 미확정(undefined)은 fail-close", () => {
  assert.equal(phaseFiltersTrusted({ hasSeries: true, seriesConfirmed: true, seasonConfirmed: undefined }), false);
});
// 삼순 NO-GO(3차): series 셀렉터 부재를 신뢰하면 default/비정규 표를 수집할 수 있다 → fail-close.
check("series 셀렉터 부재(hasSeries=false)는 season 이 맞아도 fail-close", () => {
  assert.equal(phaseFiltersTrusted({ hasSeries: false, seriesConfirmed: true, seasonConfirmed: true }), false);
  assert.equal(phaseFiltersTrusted({ hasSeries: false, seriesConfirmed: false, seasonConfirmed: true }), false);
});

console.log("\n§5 실제 저장본 — 정상 데이터가 이 게이트를 통과하는가 (삼순 NO-GO ①)");

/* 합성 fixture 만 보면 "게이트가 프로덕션 크롤을 영구 RED 로 만든다"를 놓친다.
 * 이전 판이 정확히 그랬다 — 전체 roster(투수·미출장 보존분 포함)를 baseline 으로 두고
 * 타자 phase 수집분과 비교해, 실측상 10팀 전부 FAIL 이었다. 그래서 실제 커밋된
 * 저장본으로 축이 맞는지 확인한다. */

const roster = JSON.parse(readFileSync(join(CONSTANTS, "players-roster.json"), "utf-8"));
const rosterById = new Map(roster.map((p) => [String(p.kboId), p]));
const batters = JSON.parse(readFileSync(join(CONSTANTS, "stats-2026-batters.json"), "utf-8"));
const pitchers = JSON.parse(readFileSync(join(CONSTANTS, "stats-2026-pitchers.json"), "utf-8"));

const phases = {
  batters: buildPhaseBaseline(batters, rosterById),
  pitchers: buildPhaseBaseline(pitchers, rosterById),
};

check("phase baseline 이 10개 팀 전부에 대해 산출된다", () => {
  for (const [phase, m] of Object.entries(phases)) {
    assert.equal(m.size, 10, `${phase} baseline 팀 수 ${m.size}`);
  }
});

check("저장본과 같은 수집을 재현하면 전 팀 통과한다 (축 일치)", () => {
  for (const [phase, baselineMap] of Object.entries(phases)) {
    for (const [teamId, count] of baselineMap) {
      const r = evaluateTeamCollection({
        selectConfirmed: true,
        requestedTeamName: `팀${teamId}`,
        observedTeamNames: Array(count).fill(`팀${teamId}`),
        collected: count,
        uniqueIds: count,
        pagerComplete: true,
        baseline: count,
      });
      assert.equal(r.ok, true, `${phase} teamId=${teamId} (${count}명) 이 실패: ${r.reason} ${r.detail}`);
    }
  }
});

check("전체 roster 를 baseline 으로 쓰면 실패한다 — 축이 다르다는 증거", () => {
  const rosterAllByTeam = new Map();
  for (const p of roster) {
    if (p.teamId == null) continue;
    rosterAllByTeam.set(p.teamId, (rosterAllByTeam.get(p.teamId) || 0) + 1);
  }
  let wouldFail = 0;
  for (const [teamId, count] of phases.batters) {
    const r = evaluateTeamCollection({
      selectConfirmed: true,
      requestedTeamName: `팀${teamId}`,
      observedTeamNames: Array(count).fill(`팀${teamId}`),
      collected: count,
      uniqueIds: count,
      pagerComplete: true,
      baseline: rosterAllByTeam.get(teamId),
    });
    if (!r.ok) wouldFail++;
  }
  assert.ok(
    wouldFail > 0,
    "전체 roster baseline 이 통과해버리면 이 회귀 테스트가 축 오류를 못 잡는다"
  );
});

console.log("\n§6 프로덕션 배선 — 크롤러가 실제로 이 계약을 태우는가");

const crawlerSrc = readFileSync(join(PROJECT_ROOT, "scripts/crawl-roster-v2.mjs"), "utf-8");

/** 소스 덤프 없이 패턴 존재를 단언한다(assert.match 는 실패 시 전문을 찍어 로그를 덮는다). */
function hasSrc(re, msg) {
  assert.ok(re.test(crawlerSrc), `${msg} (패턴 미매칭: ${re})`);
}

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
  assert.ok(failIdx > 0 && writeIdx > 0);
  assert.ok(failIdx < writeIdx, "완주 판정이 저장보다 뒤에 있다 — 오염 데이터가 저장된다");
});

// 삼순 NO-GO ① (구조): 크롤러가 season/series 전이 반환을 소비해 fail-close 해야 한다.
// 행동 검증은 위 phaseFiltersTrusted 테스트가, 배선 연결은 이 구조 가드가 맡는다.
check("크롤러가 setupPhaseFilters 반환을 소비해 phase fail-close 한다", () => {
  assert.match(crawlerSrc, /async function setupPhaseFilters\(/, "setupPhaseFilters 헬퍼가 없다");
  // setupPhaseFilters 가 순수함수 판정을 **그대로 반환**해야 한다 — `return true` 로 바꾸면 season 전이 실패가 샰다.
  assert.match(
    crawlerSrc,
    /return phaseFiltersTrusted\(\{ hasSeries, seriesConfirmed, seasonConfirmed \}\);/,
    "setupPhaseFilters 가 phaseFiltersTrusted 결과를 반환하지 않는다"
  );
  // series·season 전이 반환을 모두 실제 변수에 받아야 한다(반환 무시/하드코딩 방지).
  // 삼순 NO-GO(3차): season 만 pin 하면 seriesConfirmed 하드코딩을 못 잡는다.
  assert.match(
    crawlerSrc,
    /seriesConfirmed = hasSeries\s*\?\s*await changeSelectAndWait\(page, seriesSel, "0"/,
    "crawler 가 series 전이 반환을 소비하지 않는다(하드코딩 fail-open)"
  );
  // selector 부재 시 false 로 떨어져야 한다.
  assert.match(crawlerSrc, /:\s*false;/, "selector 부재를 false 로 내리지 않는다");
  assert.match(crawlerSrc, /const seasonConfirmed = await changeSelectAndWait\(page, seasonSel/);
  // 두 phase 모두 반환을 변수로 받아 실패 시 슬롯을 fail-close outcome 으로 넣어야 한다.
  assert.match(crawlerSrc, /const battersFilterOk = await setupPhaseFilters\(/);
  assert.match(crawlerSrc, /const pitchersFilterOk = await setupPhaseFilters\(/);
  assert.match(
    crawlerSrc,
    /if \(!battersFilterOk\)[\s\S]{0,200}phaseFilterFailureOutcome\(/,
    "batters 전이 실패 시 fail-close outcome 을 안 넣는다"
  );
  assert.match(
    crawlerSrc,
    /if \(!pitchersFilterOk\)[\s\S]{0,200}phaseFilterFailureOutcome\(/,
    "pitchers 전이 실패 시 fail-close outcome 을 안 넣는다"
  );
});

// 삼순 NO-GO ② (구조): 크롤러가 개수가 아니라 key 집합으로 완주를 판정해야 한다.
check("크롤러가 expected 슬롯 key 집합으로 완주 판정한다 (count 아님)", () => {
  assert.match(crawlerSrc, /buildExpectedSlotKeys\(/, "key 집합 대신 개수를 쓰고 있다");
  assert.doesNotMatch(
    crawlerSrc,
    /evaluateRosterCompletion\(\s*teamOutcomes\s*,\s*TEAMS\.length\s*\*\s*2\s*\)/,
    "개수-only 호출이 남아 있다"
  );
});

// 삼순 NO-GO ①. 없으면 actual crawl 이 영구 RED.
check("크롤러가 phase baseline 을 쓴다 (전체 roster 아님)", () => {
  assert.match(crawlerSrc, /buildPhaseBaseline\(/);
  assert.doesNotMatch(crawlerSrc, /buildTeamBaseline\(/, "전체 roster baseline 은 축이 틀렸다");
  assert.match(crawlerSrc, /baselineByPhase\.batters\.get\(teamId\)/);
  assert.match(crawlerSrc, /baselineByPhase\.pitchers\.get\(teamId\)/);
});

// 삼순 NO-GO ②.
// ⚠︎ `observedTeamNames:` · `teamNameCell` 의 *존재*만 보면 검출력이 0 이다 —
// 실측: witness 를 `map(() => teamName)` 으로 위조해도 두 문자열이 그대로 남아 GREEN 이었다.
// 표에서 읽은 값이 판정으로 *흐르는 경로* 를 붙여서 본다.
check("크롤러가 표에서 읽은 팀명을 그대로 판정에 넘긴다", () => {
  hasSrc(/requestedTeamName:\s*teamName/, "요청 팀명을 판정에 넘겨야 한다");
  hasSrc(
    /observedTeamNames:\s*usable\.map\(\(r\) => r\.teamNameCell\)/,
    "witness 는 수집 행의 teamNameCell 이어야 한다 — 요청값을 되둘려주면 대조 자체가 무의미"
  );
  hasSrc(/teamNameCell:\s*r\.texts\[2\]/, "KBO 표 헤더 실측상 3번째 컬럼이 팀명이다");
});

// 삼순 NO-GO ③.
check("scrapeAllPages 가 pagerComplete 를 돌려주고 크롤러가 그걸 넘긴다", () => {
  assert.match(crawlerSrc, /pagerComplete:\s*pageNum === 1/, "중간 빈 페이지를 정상 종료로 보면 안 된다");
  assert.match(crawlerSrc, /pagerComplete,?\n/, "판정에 pagerComplete 를 넘겨야 한다");
});

check("크롤러가 중복 ID 를 판정에 넘긴다", () => {
  hasSrc(
    /uniqueIds:\s*new Set\(usable\.map\(\(r\) => r\.playerId\)\)\.size/,
    "중복 검출은 수집 행의 playerId 집합 크기여야 한다"
  );
});

// ⚠︎ 호출 *존재*만 보면 검출력이 0 이다 — 실측: 안정성 반영을 `if (false)` 로 끊어도
// 호출문은 남아 GREEN 이었다. 판정이 `result` 로 *반영되는 경로* 를 본다.
check("크롤러가 독립 재조회로 집합 안정성을 보고 결과에 반영한다", () => {
  hasSrc(/const second = await collectPass\(\);/, "재조회는 독립 수집(collectPass)이어야 한다");
  // 안정성 결과가 result 로 들어가야 한다.
  hasSrc(
    /result = second\.verdict\.ok[\s\S]{0,200}evaluateSetStability\(/,
    "재조회 판정이 result 로 반영되지 않으면 재조회는 구경거리다"
  );
  // 삼순 NO-GO 2: 2차도 자체 판정(team witness/pager/중복)을 통과해야 한다.
  hasSrc(
    /:\s*second\.verdict;/,
    "2차가 자체 판정을 실패하면 그 사유로 fail-close 해야 한다 — ID 집합만 비교하면 2차 오염을 못 본다"
  );
  // 안정성 판정은 applyRows 보다 앞서야 오염 행이 들어가지 않는다.
  const stabIdx = crawlerSrc.indexOf("evaluateSetStability(");
  const applyIdx = crawlerSrc.indexOf("applyRows(first.usable");
  assert.ok(stabIdx > 0 && applyIdx > 0, "안정성 판정이나 반영 호출을 찾지 못했다");
  assert.ok(stabIdx < applyIdx, "안정성 판정이 반영보다 뒤에 있다");
});

// 삼순 NO-GO 2: reset 실패를 무시하면 "독립 재조회"가 같은 표 재독이 된다.
check("필터 reset 실패를 fail-close 한다", () => {
  hasSrc(
    /const resetOk = await changeSelectAndWait\(page, teamSel, "", 5000\)\.catch\(\(\) => false\);/,
    "reset 결과를 버리면 안 된다"
  );
  hasSrc(
    /if \(!resetOk\)[\s\S]{0,300}SELECT_UNCONFIRMED/,
    "reset 실패 시 수집을 진행하면 이전 팀 표를 재독할 수 있다"
  );
});

/* 삼순 NO-GO(3차) ① — 셀렉트 값만으로는 재조회를 증명하지 못한다.
 * 종전 `changeSelectAndWait` 는 표 전이가 timeout 돼도 `settled === value` 만 보고 true 를
 * 돌렸다. select 값은 브라우저가 즉시 반영하므로 서버 응답 없이도 항상 true 가 된다.
 * 그러면 reset 이 실패해도 같은 팀 stale 표를 두 번 읽고 "집합 동일"로 통과한다.
 * 실측: 이 페이지는 `Sys.WebForms.PageRequestManager` 기반 부분 포스트백이라
 * (팀 전환 시 POST 1건 / `framenavigated` 0 / 컨테이너 `...udpContent`)
 * `endRequest` 에포크로 응답 도착을 직접 셀 수 있다. */
check("전이 증거가 없으면 changeSelectAndWait 가 false 를 돌린다", () => {
  hasSrc(
    /if \(!advanced\) return false;/,
    "timeout 을 통과시키면 stale 표를 든 채 true 가 된다"
  );
  // 종전처럼 `settled === value` 만으로 돌아가면 안 된다.
  const fn = /async function changeSelectAndWait[\s\S]*?\n\}/.exec(crawlerSrc)?.[0] || "";
  assert.ok(fn, "changeSelectAndWait 를 찾지 못했다");
  assert.ok(
    /const advanced = await page[\s\S]*?\.catch\(\(\) => false\)/.test(fn),
    "전이 여부를 boolean 으로 받아 반영해야 한다"
  );
  assert.ok(
    !/\} catch \{\s*\n\s*await page\.waitForTimeout\(waitMs\);/.test(fn),
    "timeout 을 고정 대기로 삼키는 종전 경로가 남아 있다"
  );
});

check("재조회 증거로 서버 응답 epoch 을 쓴다", () => {
  hasSrc(/prm\.add_endRequest\(/, "PageRequestManager endRequest 훅이 없다");
  hasSrc(
    /return \(window\.__kboEpoch \?\? 0\) > epochBefore;/,
    "epoch 증가를 전이 판정으로 써야 한다 — 표 변화만으로는 같은 결과 팀에서 오판한다"
  );
});

/* 삼순 NO-GO(4차) — epoch 을 못 쓰는 경로가 약한 근거로 빠져나가면 계약이 무효다.
 *
 * 3차 판에는 둘 다 폴백이 살아 있었다:
 *   changeSelectAndWait: `epochBefore === null` 이면 **첫행 변화**로 통과
 *   ensureFirstPage    : `epochBefore === null` 이면 **표시 `on`**만 보고 true
 * 둘 다 브라우저 로컬 상태라 서버 응답 없이도 참이 될 수 있고,
 * 그게 바로 KT 투수가 통째로 비었던 경로다.
 * → epoch 미설치/실패는 **검증 불가 = fail-close** 여야 한다. */
check("epoch 을 못 쓰면 전이 판정을 fail-close 한다 (약한 근거 폴백 금지)", () => {
  const sel = /async function changeSelectAndWait[\s\S]*?\n\}/.exec(crawlerSrc)?.[0] || "";
  const first = /async function ensureFirstPage[\s\S]*?\n\}/.exec(crawlerSrc)?.[0] || "";
  assert.ok(sel && first, "대상 함수를 찾지 못했다");

  for (const [name, fn] of [["changeSelectAndWait", sel], ["ensureFirstPage", first]]) {
    assert.ok(
      /if \(!\(await installRequestEpoch\(page\)\)\) return false;/.test(fn),
      `${name}: epoch 훅 설치 실패를 fail-close 하지 않는다`
    );
    assert.ok(
      /if \(epochBefore === null\) return false;/.test(fn),
      `${name}: epoch 읽기 실패를 fail-close 하지 않는다`
    );
    // 약한 근거로 대체하는 분기가 다시 생기면 안 된다.
    assert.ok(
      !/epochBefore !== null/.test(fn),
      `${name}: epoch 유무에 따른 분기가 남아 있다 — 폴백 경로가 부활했다`
    );
  }
  // 표시 `on` 만 보고 1페이지라 단정하는 경로가 없어야 한다.
  assert.ok(
    !/return on === null \|\| on === "1";/.test(first),
    "ensureFirstPage: 표시만 보는 약한 판정이 남아 있다"
  );
  // 첫행 변화 폴백도 안 된다(같은 팀 재선택이면 영원히 false, 부분렌더면 true).
  assert.ok(
    !/firstRow !== beforeFirstRow/.test(sel),
    "changeSelectAndWait: 첫행 비교 폴백이 남아 있다"
  );
});

/* 삼순 NO-GO(5차) — `endRequest` 는 성공 전용이 아니다.
 * MS 문서(Working with PageRequestManager Events)에 따르면 오류로 끝난 부분
 * 포스트백도 `endRequest` 를 발화시키며 오류는 `EndRequestEventArgs.get_error()`
 * 로 전달된다. 오류까지 epoch 으로 세면 "서버가 응답했다"가 증명되지 않아,
 * 실패한 reset/select/1번클릭 뒤에도 로컬 select 값·표시 `on`·같은 팀 stale 표로
 * 두 집합이 동일하게 통과할 수 있다 — 4차까지 막은 경로가 오류 응답으로 부활한다. */
/* 삼순 NO-GO(6차) — 그리고 이 게이트가 놓친 이유.
 *
 * 5차 판은 소스 문자열로 `args?.get_error?.() != null` 를 확인하고
 * "판단 불가는 fail-close" 라고 통과시켰다. 그러나 optional call 은
 * args 나 메서드가 없을 때 throw 가 아니라 `undefined` 를 반환하므로
 * `undefined != null` → `false`, 즉 **성공으로 샐다**(fail-open).
 * 실측: args=null → false, get_error 없음 → false (둘 다 성공 취급).
 *
 * 문자열 검사는 "어떻게 쓰였나"를 볼 뿐 "어떻게 동작하나"를 보지 못한다.
 * 그래서 판정을 `classifyEndRequest` 순수 함수로 뽑아내고, 여기서는
 * **그 함수를 직접 호출해** 행동 매트릭스를 고정한다. 크롤러는 같은 함수를
 * 페이지에 주입해 쓰므로, 이 테스트가 실제 배선된 판정을 검증한다. */
check("endRequest 판정 행동 매트릭스 (오류 없는 응답만 성공)", () => {
  // 유일한 성공 — "오류가 없다"가 **명시된** 경우만.
  assert.equal(classifyEndRequest({ get_error: () => null }), "success", "null 오류는 성공이어야 한다");

  /* 삼순 NO-GO(7차) — `undefined` 를 성공으로 묶은 것이 fail-open 이었다.
   * 그건 "오류 없음"이 명시된 값이 아니라 값이 없다는 신호 — 판단불가다.
   * 더구나 6차에서 내가 이걸 테스트로 **계약까지 박아둑었다**(게이트가 결함을
   * 고정시키는 가장 나쁜 형태). epoch 은 "서버가 정상 응답했다"는 유일한 근거라
   * 모호한 값을 성공으로 세면 가설 자체가 약해진다. */
  assert.equal(
    classifyEndRequest({ get_error: () => undefined }),
    "error",
    "undefined 는 '오류 없음'이 명시된 값이 아니다 — 판단불가 → 실패여야 한다"
  );
  assert.equal(
    classifyEndRequest({ get_error: () => {} }),
    "error",
    "암시적 undefined 반환(return 문 없음)도 판단불가다"
  );

  // 실제 오류.
  assert.equal(
    classifyEndRequest({ get_error: () => new Error("boom") }),
    "error",
    "Error 를 받고도 성공으로 세면 실패한 포스트백이 재조회 증거가 된다"
  );

  // 판단 불가 = fail-close. 이 세 줄이 6차 NO-GO 의 핵심이다.
  assert.equal(classifyEndRequest(null), "error", "args 가 null 이면 판단 불가 → 실패여야 한다");
  assert.equal(classifyEndRequest(undefined), "error", "args 가 undefined 이면 판단 불가 → 실패여야 한다");
  assert.equal(classifyEndRequest({}), "error", "get_error 가 없으면 판단 불가 → 실패여야 한다");
  assert.equal(
    classifyEndRequest({ get_error: 123 }),
    "error",
    "get_error 가 함수가 아니면 판단 불가 → 실패여야 한다"
  );
  assert.equal(
    classifyEndRequest({ get_error: () => { throw new Error("x"); } }),
    "error",
    "get_error 가 throw 하면 판단 불가 → 실패여야 한다"
  );

  // ⚠︎ 프로퍼티 **접근** 자체가 터지는 경우.
  // mutation U3 를 돌려보고 발견했다 — `typeof args.get_error` 를 try 밖에 두면
  // 예외가 endRequest 핸들러 밖으로 전파돼 오류 집계조차 못 한다.
  // (변이본이 원본보다 안전해서 드러난 자체 결함이다.)
  assert.equal(
    classifyEndRequest({ get get_error() { throw new Error("getter"); } }),
    "error",
    "throwing getter 에서 예외가 새면 핸들러가 터져 오류 집계가 안 된다"
  );
});

check("크롤러가 그 판정 함수를 실제로 페이지에 배선한다", () => {
  const fn = /async function installRequestEpoch[\s\S]*?\n\}/.exec(crawlerSrc)?.[0] || "";
  assert.ok(fn, "installRequestEpoch 를 찾지 못했다");

  // 판정을 인라인으로 다시 쓰면 위 매트릭스 테스트가 헛돈다.
  hasSrc(
    /window\.__kboClassifyEndRequest = new Function/,
    "판정 함수 원본을 페이지에 주입하지 않는다"
  );
  hasSrc(
    /classifyEndRequest\.toString\(\)/,
    "주입 소스가 lib 의 classifyEndRequest 가 아니면 테스트가 다른 코드를 검증하게 된다"
  );
  assert.ok(
    /const verdict = window\.__kboClassifyEndRequest\(args\);/.test(fn),
    "endRequest 핸들러가 주입된 판정 함수를 쓰지 않는다"
  );
  assert.ok(
    /if \(verdict !== "success"\) \{[\s\S]{0,200}return;\n\s*\}/.test(fn),
    "success 가 아닌 응답에서 early-return 하지 않는다"
  );
  // 주입 실패는 검증 불가 → fail-close.
  assert.ok(
    /if \(!ready\) return false;/.test(fn),
    "판정 함수 주입 실패를 통과시킨다 — 재조회 증거를 만들 수 없으므로 fail-close 여야 한다"
  );
  // optional call fail-open 이 다시 생기면 안 된다.
  assert.ok(
    !/args\?\.get_error\?\.\(\)/.test(crawlerSrc),
    "optional call 판정이 남아 있다 — args/메서드 부재 시 undefined 를 돌려 성공으로 샘다"
  );
});

check("installRequestEpoch 가 PRM 을 기다렸다가 fail-close 한다", () => {
  const fn = /async function installRequestEpoch[\s\S]*?\n\}/.exec(crawlerSrc)?.[0] || "";
  assert.ok(fn, "installRequestEpoch 를 찾지 못했다");
  assert.ok(
    /deadline/.test(fn) && /waitForTimeout/.test(fn),
    "PRM 은 스크립트 로드 뒤에 생긴다 — 1회 호출로 단정하면 오판한다"
  );
  assert.ok(/return false;/.test(fn), "설치 실패를 false 로 말해야 한다");
});

/* 삼순 NO-GO(3차) ② — `while (true)` 에 상한이 없으면 한 pass 가 영원히 돌아
 * 상위의 `maxAttempts = 3` 재시도까지 무효화된다. */
check("페이지 순회에 상한이 있다", () => {
  hasSrc(/MAX_PAGES_PER_TEAM/, "페이지 상한 상수가 없다");
  hasSrc(
    /if \(pageNum > MAX_PAGES_PER_TEAM\) \{[\s\S]{0,220}max_pages_exceeded_/,
    "상한 초과를 fail-close 하지 않는다"
  );
});

check("페이저 순환을 감지해 fail-close 한다", () => {
  hasSrc(/const seenStates = new Set\(\);/, "방문 상태 집합이 없다");
  hasSrc(
    /if \(seenStates\.has\(pagerState\)\) \{[\s\S]{0,200}pager_cycle_at_/,
    "같은 페이저 상태 재방문을 통과시키면 순환이 무한히 돌 수 있다"
  );
  hasSrc(/seenStates\.add\(pagerState\);/, "상태를 기록하지 않으면 감지가 무의미다");
});

/* 삼순 NO-GO(2차) 보완 중 dry-run 으로 발견한 페이저 상태 오염 — 정적 검사로는 안 보였다.
 * KBO 그리드는 팀 필터를 바꿔도 페이지 인덱스를 유지한다.
 * 실측(팀 순회 LG→두산→KIA): 두산 2페이지에서 끝난 뒤 KIA 로 전환 → KIA rows=0.
 * KIA 를 단독으로 조회하면 30행이므로 KBO 결함이 아니라 순회 순서 의존 버그다. */
check("팀 전환 전에 페이저를 1페이지로 되돌린다", () => {
  const idxReset = crawlerSrc.indexOf("await ensureFirstPage(page);");
  const idxSelect = crawlerSrc.indexOf("const selectConfirmed = await changeSelectAndWait(page, teamSel, teamCode");
  assert.ok(idxReset > 0, "팀 전환 전 ensureFirstPage 호출이 없다 — 이전 팀 페이지 인덱스가 새다");
  assert.ok(idxSelect > 0, "팀 셀렉트 호출을 찾지 못했다");
  assert.ok(idxReset < idxSelect, "페이지 리셋이 팀 전환보다 뒤에 있다");
});

check("수집 시작 시에도 1페이지를 보장하고 실패면 fail-close 한다", () => {
  hasSrc(
    /if \(!\(await ensureFirstPage\(page\)\)\) \{[\s\S]{0,160}"cannot_reach_first_page"/,
    "scrapeAllPages 진입 시 1페이지 보장이 없거나 실패를 통과시킨다"
  );
});

/* full dry-run(20슬롯)에서 드러난 추가 결함 — 표시상 `on` 은 서버 상태가 아니다.
 * 실측(투수 페이지, LG→KT):
 *   LG 2페이지 순회 → on=2 / 팀 필터 reset → **on=1 표시**인데 rows=0
 *   그 상태에서 KT 선택 → rows=0 (KT 투수는 1페이지뿐인데도)
 *   "1" 버튼을 명시적으로 클릭 → rows=23 ✅
 * 즉 구판의 `on === "1"` 조기종료는 아무것도 안 하고 통과했고, 서버 내부 인덱스는 2 로
 * 남아 단일 페이지 팀이 통째로 비었다. */
check("ensureFirstPage 가 표시상 on 을 신뢰해 조기종료하지 않는다", () => {
  const fn = /async function ensureFirstPage[\s\S]*?\n\}/.exec(crawlerSrc)?.[0] || "";
  assert.ok(fn, "ensureFirstPage 를 찾지 못했다");
  assert.ok(
    !/if \(on === null \|\| on === "1"\) return true;/.test(fn),
    "표시가 1 이라고 조기종료하면 서버 인덱스가 2 로 남아 단일페이지 팀이 비게 된다"
  );
  assert.ok(
    /await first\.click\(\)/.test(fn),
    "항상 1번 버튼을 눌러 서버 상태를 강제로 맞춰야 한다"
  );
  assert.ok(
    /__kboEpoch \?\? 0\) <= prev/.test(fn),
    "1페이지 복귀도 서버 응답(epoch)으로 확인해야 한다"
  );
});

// 진단이 가려지면 원인 추적이 느려진다 — KT 가 `empty` 로 찍혔지만 진짜 원인은 페이저였다.
check("미완주를 empty 보다 먼저 보고한다 (진단 순서)", () => {
  const r = evaluateTeamCollection(
    okInput({ collected: 0, uniqueIds: 0, observedTeamNames: [], pagerComplete: false })
  );
  assert.equal(r.ok, false);
  assert.equal(
    r.reason,
    TEAM_FAIL_REASONS.PAGER_INCOMPLETE,
    "수집이 끝나지 않았는데 empty 로 보고하면 원인이 가려진다"
  );
});

// 없으면: 페이지가 안 넘어간 채로 같은 표를 다시 긁어 중복이 쌓인다(dry-run 실측: 10행/5고유).
check("페이지 전이가 확인되지 않으면 미완주로 판정한다", () => {
  hasSrc(
    /if \(!advanced\) \{[\s\S]{0,200}page_advance_failed_at_/,
    "페이지 전이 실패를 통과시키면 중복 수집이 된다"
  );
  hasSrc(
    /const advanced = await page[\s\S]{0,800}?\.then\(\(\) => true\)\s*\n\s*\.catch\(\(\) => false\)/,
    "전이 여부를 boolean 으로 받아야 한다"
  );
  // 전이 판정은 첫행 변경만으로는 부족하다 — 페이저 `on` 이 목표 페이지여야 한다.
  hasSrc(/on === target/, "페이저 현재 페이지(on)가 목표와 같은지 확인해야 한다");
});

// 없으면: ASP.NET 부분 포스트백 중간의 부분·빈 표를 읽는다.
check("표가 안정되기 전에는 읽지 않는다", () => {
  hasSrc(
    /if \(!\(await waitForTableSettled\(page\)\)\) \{[\s\S]{0,200}table_unsettled_at_/,
    "표 안정 대기가 없거나 미안정을 통과시킨다"
  );
  // 행 수만 보면 부분 렌더가 우연히 같은 수로 멈춰 있을 때 안정으로 오인한다.
  hasSrc(
    /return `\$\{trs\.length\}\|\$\{first\}\|\$\{last\}`/,
    "안정 판정은 행 수 + 첫행 + 끝행 서명이어야 한다"
  );
  hasSrc(/stableHits >= 3/, "연속 3회 동일을 요구해야 한다");
});

// 삼순 NO-GO 3: 활성 next 를 눌렀는데 pager 불변 = 전이 실패지 EOF 가 아니다.
check("stalled navigation 을 정상 EOF 로 보지 않는다", () => {
  hasSrc(
    /pagerComplete:\s*false,\s*reason:\s*"stalled_navigation"/,
    "pager 불변은 미완주로 판정해야 한다"
  );
  hasSrc(/reason:\s*"next_disabled"/, "비활성 next 는 명시적 끝으로 인정한다");
  assert.ok(
    !/reason:\s*"last_group"/.test(crawlerSrc),
    "pager 불변을 last_group 으로 통과시키던 경로가 남아 있다"
  );
});

check("changeSelectAndWait 가 셀렉트 확정 여부를 반환한다", () => {
  assert.match(
    crawlerSrc,
    /const settled = await page\.\$eval\(selector[\s\S]{0,120}return settled === value;/
  );
});

check("팀 수집이 bounded retry 를 태운다", () => {
  assert.match(crawlerSrc, /maxAttempts/);
  assert.match(crawlerSrc, /collectTeamWithContract\(/);
});

/* 삼순 NO-GO(2차) 1 — production-path blocker.
 * `toUsableRows` 는 `{playerId, name, teamNameCell}` 을 돌려주는데 `applyRows` 가
 * 원본 DOM 필드(`r.hrefs[1]` / `r.texts[1]`)를 읽으면 **첫 성공 팀에서 TypeError** 로 죽는다.
 * 실측 재현: `({playerId,name,teamNameCell}).hrefs[1]`
 *   → TypeError: Cannot read properties of undefined (reading '1')
 * 종전 게이트는 apply 경로를 실행하지 않아 37 PASS 인 채 이걸 놓쳤다. */
check("applyRows 가 toUsableRows 산출물 계약을 따른다 (DOM 필드 읽기 금지)", () => {
  const blocks = [...crawlerSrc.matchAll(/applyRows:\s*\(rows, tid, tname\) => \{([\s\S]*?)\n        \},/g)].map(
    (m) => m[1]
  );
  assert.equal(blocks.length, 2, `applyRows 블록을 2개 찾지 못했다 (${blocks.length}개)`);
  for (const [i, body] of blocks.entries()) {
    assert.ok(
      !/r\.hrefs|r\.texts/.test(body),
      `applyRows[${i}] 가 원본 DOM 필드(r.hrefs/r.texts)를 읽는다 — 프로덕션에서 TypeError`
    );
    assert.ok(
      /r\.playerId/.test(body) && /r\.name/.test(body),
      `applyRows[${i}] 가 toUsableRows 의 playerId/name 을 쓰지 않는다`
    );
  }
});

// 위 정적 검사만으로는 "실제로 안 죽는다"를 못 보증한다 — 계약대로 호출해 본다.
check("toUsableRows 산출물 형상이 실제 apply 계약과 맞는다", () => {
  // toUsableRows 가 만드는 행의 형상을 소스에서 확정한다.
  hasSrc(
    /usable\.push\(\{ playerId, name, teamNameCell: r\.texts\[2\] \|\| "" \}\)/,
    "toUsableRows 산출 형상이 바뀌었다 — apply 계약과 같이 갱신해야 한다"
  );
  // 그 형상에서 DOM 필드 접근은 실제로 터진다(이게 삼순가 지적한 축이다).
  const sample = { playerId: "123", name: "홍길동", teamNameCell: "LG" };
  assert.throws(
    () => sample.hrefs[1],
    TypeError,
    "산출물에 hrefs 가 생겼다면 이 계약 검사를 다시 짜야 한다"
  );
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
