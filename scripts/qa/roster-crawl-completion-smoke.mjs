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
  evaluateTeamCollection,
  evaluateSetStability,
  evaluateRosterCompletion,
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

const okOutcome = (teamName, phase) => ({
  teamName,
  phase,
  attempts: 1,
  result: { ok: true, reason: null, detail: "수집 30명" },
});

check("전 슬롯 성공이면 완주", () => {
  const outcomes = [];
  for (const phase of ["batters", "pitchers"]) {
    for (let i = 0; i < 10; i++) outcomes.push(okOutcome(`T${i}`, phase));
  }
  assert.equal(evaluateRosterCompletion(outcomes, 20).complete, true);
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
