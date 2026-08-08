/**
 * 원본 **행 존재 불안정** 계약 스모크.
 *
 * 배경(2026-08-08): 자동 스탯 갱신이 8/6·8/7 연속 죽었고 실패 문구는 늘 같았다
 * (`수비: KBO에 있으나 우리 데이터에 없음 — playerId=54214|중견수`). 원인은 오염이 아니라
 * KBO 가 같은 URL 을 조회할 때마다 그 행을 줬다 안 줬다 하는 것이었다(824↔825 실측).
 *
 * ⚠︎ 이 스모크의 목적은 "완화가 어디까지인지"를 못 박는 것이다. 두 축을 함께 고정한다.
 *   ① 불안정 행은 **행 집합** 판정에서 빠진다 (거짓 RED 제거)
 *   ② 그 외 전부는 종전과 **동일하게 엄격**하다 — 특히 값 대조·안정 행 누락·수집 실패
 *
 * ②가 없으면 이 파일은 게이트를 지운 것과 같다. 그래서 "통과하는지"보다
 * **"여전히 죽는지"** 를 더 많이 검사한다.
 *
 * ── 2026-08-08 삼순 NO-GO 3건 반영 ──────────────────────────────
 * 1. 하한이 2였을 때 `좌,좌` 우연이 그대로 통과했다 → N=3 + baseline 결속
 * 2. union 이 first/last 중 하나만 남겨 회차별 값 충돌이 사라졌다 → valueConflictKeys
 * 3. 재판정이 최초 관측·최초 failure 를 통째 교체했다 → 최초 포함 3회 + 비-row failure 보존
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LEDGER_MIN_ALLOWANCE,
  MIN_CONFIRM_READS,
  MISS_RUNS_BEFORE_DELETE,
  assertConfirmReads,
  assertLedgerBounded,
  classifyRowStability,
  describeUnstableRows,
  describeValueConflicts,
  ledgerKeySet,
  planRowSnapshot,
} from "../lib/source-row-stability.mjs";
import {
  crossCheckDataset,
  digestSourceMaps,
  judgeWithConfirmation,
  mergeConfirmedJudgement,
} from "../lib/stats-source-truth.mjs";

let passed = 0;
const pending = [];
const check = (label, fn) => {
  const outcome = fn();
  if (outcome && typeof outcome.then === "function") {
    // async 검사를 동기처럼 받아 삼키면 rejection 이 무시돼 GREEN 이 된다.
    pending.push(outcome.then(() => {
      passed++;
      console.log(`  ✓ ${label}`);
    }));
    return;
  }
  passed++;
  console.log(`  ✓ ${label}`);
};
const throws = (label, fn, pattern) => {
  assert.throws(fn, pattern, `${label}: 던져야 한다`);
  passed++;
  console.log(`  ✓ ${label}`);
};

/** KBO 원본 한 회차 = `key → 셀 배열`. 셀 1번이 이름, 3번이 포지션이다. */
const obs = (entries) => new Map(entries);
const cell = (name, pos, games) =>
  ["1", name, "두산", pos, String(games), "", "1", "0", "0", "1", "0", "0", "1.000", "0", "0", "0"];

const LEFT = "54214|좌익수";
const CENTER = "54214|중견수";
const readLeft = () => obs([[LEFT, cell("전다민", "좌익수", 1)]]);
const readBoth = () => obs([
  [LEFT, cell("전다민", "좌익수", 1)],
  [CENTER, cell("전다민", "중견수", 1)],
]);

console.log("\n▸ 관측 접기(classifyRowStability)");

check("전 회차 공통 행 = stable", () => {
  const result = classifyRowStability([readBoth(), readBoth(), readBoth()]);
  assert.deepEqual([...result.stableKeys].sort(), [LEFT, CENTER].sort());
  assert.equal(result.unstableKeys.size, 0);
});

check("일부 회차만 관측된 행 = unstable (전다민 824↔825 실측 형상)", () => {
  const result = classifyRowStability([readLeft(), readBoth(), readLeft()]);
  assert.deepEqual([...result.stableKeys], [LEFT]);
  assert.deepEqual([...result.unstableKeys], [CENTER]);
  // union 에는 남는다 — 값 대조 대상이기 때문이다.
  assert.ok(result.union.has(CENTER));
  assert.equal(result.seenCount.get(CENTER), 1);
});

throws("관측 0회 = 통과가 아니라 실패", () => classifyRowStability([]), /row_stability_no_observations/);

throws(
  "0행 회차 = '전부 불안정'이 아니라 수집 실패",
  () => classifyRowStability([readBoth(), obs([])]),
  /row_stability_empty_observation/,
);

console.log("\n▸ ★ 삼순 NO-GO 1 — 하한 2회로는 `좌,좌` 우연이 통과했다");

throws(
  "1회 관측으로는 불안정을 판정할 수 없다",
  () => assertConfirmReads(1),
  /row_stability_insufficient_reads/,
);

throws(
  "★ 2회도 부족하다 — `좌,좌` 를 뽑으면 중견수가 조용히 사라진다",
  () => assertConfirmReads(2),
  /row_stability_insufficient_reads/,
);

check("하한은 3회다", () => {
  assert.equal(MIN_CONFIRM_READS, 3);
  assert.equal(assertConfirmReads(3), 3);
});

console.log("\n▸ ★ 삼순 NO-GO 1 — baseline 결속(운 나쁘게 전 회차 빠져도 한 런에 못 지운다)");

const plan = (input) => planRowSnapshot({ label: "수비", ...input });

check("★ baseline 좌+중 / 이번 런 좌,좌,좌 → 중견수는 보존(삭제 아님)", () => {
  const decision = plan({
    baselineByKey: new Map([[LEFT, {}], [CENTER, {}]]),
    classified: classifyRowStability([readLeft(), readLeft(), readLeft()]),
  });
  assert.deepEqual(decision.deletedKeys, [], "한 런 0회로는 지우지 않는다");
  assert.deepEqual(decision.heldKeys, [CENTER]);
  assert.equal(decision.ledger.rows[CENTER].missStreak, 1);
});

check(`연속 ${MISS_RUNS_BEFORE_DELETE}런 미관측이면 그때 제거한다`, () => {
  const decision = plan({
    baselineByKey: new Map([[LEFT, {}], [CENTER, {}]]),
    classified: classifyRowStability([readLeft(), readLeft(), readLeft()]),
    previousLedger: { rows: { [CENTER]: { observed: 0, missStreak: MISS_RUNS_BEFORE_DELETE - 1 } } },
  });
  assert.deepEqual(decision.deletedKeys, [CENTER]);
  assert.deepEqual(decision.heldKeys, []);
});

check("다시 관측되면 streak 가 리셋된다(보존도 삭제도 아님)", () => {
  const decision = plan({
    baselineByKey: new Map([[LEFT, {}], [CENTER, {}]]),
    classified: classifyRowStability([readBoth(), readBoth(), readBoth()]),
    previousLedger: { rows: { [CENTER]: { observed: 0, missStreak: MISS_RUNS_BEFORE_DELETE - 1 } } },
  });
  assert.deepEqual(decision.deletedKeys, []);
  assert.deepEqual(decision.heldKeys, []);
  assert.equal(decision.ledger.rows[CENTER], undefined, "streak 가 남으면 다음 런에 오삭제된다");
});

console.log("\n▸ ★ 삼순 NO-GO 3-b — 신규 intermittent 는 canonical 직행 금지(격리)");

check("★ 신규 `1/3` 행은 격리된다(산출물 미반영)", () => {
  const decision = plan({
    baselineByKey: new Map([[LEFT, {}]]),
    classified: classifyRowStability([readLeft(), readBoth(), readLeft()]),
  });
  assert.deepEqual(decision.quarantinedKeys, [CENTER], "한 번 스쳐 본 신규 행을 서빙에 올리지 않는다");
  assert.ok(!decision.includeKeys.includes(CENTER));
  assert.ok(decision.ledger.rows[CENTER], "원장에는 남아 다음 런에 승격 판단한다");
});

check("★ 지난 런에도 보였던 intermittent 는 승격된다", () => {
  const decision = plan({
    baselineByKey: new Map([[LEFT, {}]]),
    classified: classifyRowStability([readLeft(), readBoth(), readLeft()]),
    previousLedger: { rows: { [CENTER]: { observed: 1, missStreak: 0 } } },
  });
  assert.deepEqual(decision.quarantinedKeys, []);
  assert.ok(decision.includeKeys.includes(CENTER));
});

check("★ baseline 에 있던 intermittent 는 격리하지 않는다(기존 canonical 행)", () => {
  const decision = plan({
    baselineByKey: new Map([[LEFT, {}], [CENTER, {}]]),
    classified: classifyRowStability([readLeft(), readBoth(), readLeft()]),
  });
  assert.deepEqual(decision.quarantinedKeys, []);
  assert.ok(decision.includeKeys.includes(CENTER));
});

console.log("\n▸ ★ 삼순 NO-GO 1-b — 원장이 오라클까지 전달돼야 E2E 가 끝난다");

check("원장 key 집합이 뽑힌다", () => {
  const decision = plan({
    baselineByKey: new Map([[LEFT, {}], [CENTER, {}]]),
    classified: classifyRowStability([readLeft(), readBoth(), readLeft()]),
  });
  assert.deepEqual([...ledgerKeySet(decision.ledger)], [CENTER]);
});

check("★ 원장이 과대하면 면제가 아니라 fail-close (무제한 면제 방지)", () => {
  const rows = {};
  for (let i = 0; i < LEDGER_MIN_ALLOWANCE + 1; i++) rows[`k${i}`] = { observed: 1, missStreak: 0 };
  assert.throws(
    () => assertLedgerBounded({ rows }, 100, { label: "수비" }),
    /row_stability_ledger_overflow/,
  );
});

check("상한 이내면 통과한다", () => {
  assert.equal(assertLedgerBounded({ rows: { a: {}, b: {} } }, 800, { label: "수비" }), 2);
});

console.log("\n▸ ★ 삼순 NO-GO 2 — digest 가 flapping 으로 매번 바뀌면 freshness window 가 안 차다");

const digestOf = (defenseMap, exclude) =>
  digestSourceMaps({ defense: defenseMap }, exclude ? { excludeKeys: exclude } : undefined);

check("★ 원장 등재 행이 흔들어도 digest 는 동일하다", () => {
  const exclude = new Set([CENTER]);
  assert.equal(digestOf(readLeft(), exclude), digestOf(readBoth(), exclude));
});

check("★ 그러나 무관한 값이 바뀜면 digest 는 반드시 바뀜다(digest 를 꺼버린 게 아니다)", () => {
  const exclude = new Set([CENTER]);
  const changed = obs([[LEFT, cell("전다민", "좌익수", 7)]]);
  assert.notEqual(digestOf(readLeft(), exclude), digestOf(changed, exclude));
});

check("제외가 없으면 flapping 이 digest 를 바꿔 window 가 reset 된다(종전 동작)", () => {
  assert.notEqual(digestOf(readLeft()), digestOf(readBoth()));
});

console.log("\n▸ ★ 삼순 NO-GO 2 — 회차별 값 충돌은 first/last 로 삼키지 않는다");

check("★ 같은 key 가 회차별로 다른 값이면 valueConflictKeys 에 잡힌다 (games 1↔999)", () => {
  const result = classifyRowStability([
    obs([[CENTER, cell("전다민", "중견수", 1)]]),
    obs([[CENTER, cell("전다민", "중견수", 999)]]),
    obs([[CENTER, cell("전다민", "중견수", 1)]]),
  ]);
  assert.deepEqual([...result.valueConflictKeys], [CENTER]);
  // 충돌은 stable 여부와 무관하다 — 매 회차 나와도 값이 다르면 오염 후보다.
  assert.ok(result.stableKeys.has(CENTER));
  const note = describeValueConflicts("수비", result.valueConflictKeys);
  assert.match(note, /fail-close/);
});

check("값이 같으면 충돌이 아니다", () => {
  const result = classifyRowStability([readBoth(), readBoth(), readBoth()]);
  assert.equal(result.valueConflictKeys.size, 0);
  assert.equal(describeValueConflicts("수비", result.valueConflictKeys), null);
});

console.log("\n▸ 행 집합 판정(crossCheckDataset)");

/** 우리 산출물 한 행. */
const ours = (kboId, pos, games = 1) => ({
  name: "전다민", team: "두산", kboId, pos,
  games, ip: "1", e: 0, pko: 0, po: 1, a: 0, dp: 0, fpct: "1.000", pb: 0, sb: 0, cs: 0,
});
const DEFENSE_SPEC = {
  label: "수비",
  columns: [[4, "games"]],
  keyOf: (row) => `${String(row.kboId ?? "").trim()}|${row.pos ?? ""}`,
};

check("불안정 행이 우리 쪽에 없어도 행 집합 실패가 아니다 (거짓 RED 제거)", () => {
  const result = crossCheckDataset({
    ...DEFENSE_SPEC,
    rows: [ours("54214", "좌익수")],
    kbo: readBoth(),
    unstableKeys: new Set([CENTER]),
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.rowSetFailures, 0);
});

check("불안정 행이 우리 쪽에만 있어도 실패가 아니다 (반대 방향)", () => {
  const result = crossCheckDataset({
    ...DEFENSE_SPEC,
    rows: [ours("54214", "좌익수"), ours("54214", "중견수")],
    kbo: readLeft(),
    unstableKeys: new Set([CENTER]),
  });
  assert.deepEqual(result.failures, []);
});

check("★ 안정 행 누락은 여전히 실패다 (완화가 전체로 번지지 않는다)", () => {
  const result = crossCheckDataset({
    ...DEFENSE_SPEC,
    rows: [],
    kbo: obs([["99999|포수", cell("타인", "포수", 1)]]),
    unstableKeys: new Set([CENTER]),
  });
  assert.equal(result.rowSetFailures, 1);
  assert.match(result.failures[0], /KBO에 있으나 우리 데이터에 없음/);
});

check("★ 불안정 행이어도 값 불일치는 그대로 잡는다 (값 대조 완화 없음)", () => {
  const result = crossCheckDataset({
    ...DEFENSE_SPEC,
    rows: [ours("54214", "중견수", 999)],
    kbo: obs([[CENTER, cell("전다민", "중견수", 1)]]),
    unstableKeys: new Set([CENTER]),
  });
  assert.equal(result.rowSetFailures, 0, "행 집합은 통과");
  assert.equal(result.failures.length, 1, "값은 잡혀야 한다");
  assert.match(result.failures[0], /값 불일치.*games.*ours=999/);
});

check("★ unstableKeys 미지정이면 종전과 동일한 strict 판정", () => {
  const result = crossCheckDataset({
    ...DEFENSE_SPEC,
    rows: [],
    kbo: obs([[CENTER, cell("전다민", "중견수", 1)]]),
  });
  assert.equal(result.rowSetFailures, 1);
});

check("rowSetFailures 는 값 불일치를 세지 않는다 (재조회 트리거가 값에 반응하면 비용만 N배)", () => {
  const result = crossCheckDataset({
    ...DEFENSE_SPEC,
    rows: [ours("54214", "중견수", 7)],
    kbo: obs([[CENTER, cell("전다민", "중견수", 1)]]),
  });
  assert.equal(result.failures.length, 1);
  assert.equal(result.rowSetFailures, 0);
});

console.log("\n▸ ★ 삼순 NO-GO 3 — 최초 관측·최초 failure 를 버리지 않는다");

check("★ 행집합 실패 문장만 rowSetMessages 로 식별된다(값 실패는 보존 대상)", () => {
  const result = crossCheckDataset({
    ...DEFENSE_SPEC,
    rows: [ours("54214", "중견수", 999)],
    kbo: readBoth(),
  });
  const rowSet = result.failures.filter((line) => result.rowSetMessages.has(line));
  const carried = result.failures.filter((line) => !result.rowSetMessages.has(line));
  assert.equal(rowSet.length, 1, "좌익수 누락 = 행집합");
  assert.match(rowSet[0], /좌익수/);
  assert.equal(carried.length, 1, "games 999 = 값 실패, 재판정에서 살아남아야 한다");
  assert.match(carried[0], /값 불일치/);
});

/* ⚠︎ 아래 세 개는 **병합 함수를 직접 호출**한다.
 * 자체발견: 1차 스모크는 이 계약을 소스 문자열(`carriedFailures`, `describeValueConflicts`)로만
 * 봤고, 그래서 `carriedFailures = []` · `if (false) failures.push(conflictNote)` 변이가 둘 다
 * GREEN 이었다. 검증기가 대상 로직을 부르지 않으면 대상이 죽어도 GREEN 이다. */
const initialWithValueFailure = () => ({
  failures: ["수비: 값 불일치 playerId=54214(전다민) games ours=999 kbo=1", "수비: KBO에 있으나 우리 데이터에 없음 — playerId=54214|좌익수"],
  rowSetMessages: new Set(["수비: KBO에 있으나 우리 데이터에 없음 — playerId=54214|좌익수"]),
});

check("★ 병합: 최초의 값 실패는 재판정 후에도 살아남는다", () => {
  const merged = mergeConfirmedJudgement({
    initialResult: initialWithValueFailure(),
    confirmedResult: { failures: [] },
    conflictNote: null,
  });
  assert.equal(merged.length, 1);
  assert.match(merged[0], /값 불일치.*games ours=999/);
});

check("★ 병합: 최초의 행집합 실패는 버린다(그것만이 재조회로 바뀌는 판정이다)", () => {
  const merged = mergeConfirmedJudgement({
    initialResult: initialWithValueFailure(),
    confirmedResult: { failures: [] },
    conflictNote: null,
  });
  assert.ok(!merged.some((line) => /KBO에 있으나/.test(line)));
});

check("★ 병합: 값 충돌 note 는 반드시 최종 failure 에 들어간다(fail-close)", () => {
  const note = "수비: 원본이 같은 key 에 회차별로 다른 값을 줬다 1건";
  const merged = mergeConfirmedJudgement({
    initialResult: { failures: [], rowSetMessages: new Set() },
    confirmedResult: { failures: [] },
    conflictNote: note,
  });
  assert.deepEqual(merged, [note]);
});

console.log("\n▸ ★ 확인 판정 전체 경로(judgeWithConfirmation) — 직접 호출");

/* ⚠︎ 자체발견 2차: 병합 함수만 순수로 빼놓았더니, 그 함수에 **무엇을 넘기는가**를
 * 소스 문자열로만 봐서 `conflictNote: null` 변이가 GREEN 이었다. 수집만 주입점으로 남기고
 * 판정·병합 전체를 한 함수로 묶은 뒤, 게이트가 그걸 fake 수집기로 직접 태운다. */
const fakeConfirm = (observations) => async ({ priorObservations }) =>
  classifyRowStability([...priorObservations, ...observations]);

check("★ alternating 좌/중 → 거짓 RED 가 사라진다(나머지 갱신은 통과)", async () => {
  const spec = { ...DEFENSE_SPEC, rows: [ours("54214", "좌익수")], kbo: readBoth() };
  const initialResult = crossCheckDataset(spec);
  assert.equal(initialResult.rowSetFailures, 1, "최초엔 중견수 누락으로 RED 였다");
  const { result } = await judgeWithConfirmation({
    spec,
    initialResult,
    collectConfirmed: fakeConfirm([readLeft(), readBoth()]),
  });
  assert.deepEqual(result.failures, [], "흔들렸으므로 행집합 실패가 아니다");
});

check("★ 전체경로: 회차별 값 충돌(games 1↔999)은 fail-close 된다", async () => {
  const spec = { ...DEFENSE_SPEC, rows: [ours("54214", "좌익수")], kbo: readBoth() };
  const { result } = await judgeWithConfirmation({
    spec,
    initialResult: crossCheckDataset(spec),
    collectConfirmed: fakeConfirm([
      obs([[LEFT, cell("전다민", "좌익수", 999)], [CENTER, cell("전다민", "중견수", 1)]]),
      readBoth(),
    ]),
  });
  assert.ok(
    result.failures.some((line) => /회차별로 다른 값/.test(line)),
    "충돌을 삼키면 오염이 그대로 나간다",
  );
});

check("★ 전체경로: 안정 행이 진짜로 빠졌으면 여전히 RED", async () => {
  const spec = { ...DEFENSE_SPEC, rows: [], kbo: readBoth() };
  const { result } = await judgeWithConfirmation({
    spec,
    initialResult: crossCheckDataset(spec),
    collectConfirmed: fakeConfirm([readBoth(), readBoth()]),
  });
  assert.equal(result.failures.length, 2, "좌익수·중견수 둘 다 안정 행이다");
  assert.ok(result.failures.every((line) => /KBO에 있으나/.test(line)));
});

check("★ 전체경로: 최초의 값 불일치는 재판정 뒤에도 살아남는다", async () => {
  // 우리 쪽 중견수 games=999 (값 오염) + 좌익수는 우리에 없음(행집합)
  const spec = { ...DEFENSE_SPEC, rows: [ours("54214", "중견수", 999)], kbo: readBoth() };
  const initialResult = crossCheckDataset(spec);
  assert.ok(initialResult.failures.some((line) => /값 불일치/.test(line)));
  const { result } = await judgeWithConfirmation({
    spec,
    initialResult,
    // 좌익수를 흔들리게 만들어 행집합은 해소되게 한다 — 값 실패만 남아야 한다.
    collectConfirmed: fakeConfirm([
      obs([[CENTER, cell("전다민", "중견수", 1)]]),
      readBoth(),
    ]),
  });
  assert.ok(
    result.failures.some((line) => /값 불일치.*games ours=999/.test(line)),
    "값 오염이 재판정에서 사라지면 안 된다",
  );
});

console.log("\n▸ 결속(배선이 실제로 살아 있는가)");

check("크롤러 수비 경로가 확인 재조회 하한·baseline·값충돌에 결속돼 있다", () => {
  const source = readFileSync("scripts/crawl-stats.mjs", "utf8");
  assert.match(
    source,
    /DEFENSE_CONFIRM_READS\s*=\s*MIN_CONFIRM_READS/,
    "수비 확인 횟수가 lib 하한과 분리되면 1회로 되돌릴 수 있다",
  );
  assert.match(source, /defense_empty_observation/, "0행 회차 fail-close 가 있어야 한다");
  assert.match(source, /defense_value_conflict/, "회차별 값 충돌 fail-close 가 있어야 한다");
  assert.match(source, /planRowSnapshot/, "baseline 결속이 없으면 기존 행이 한 런에 사라진다");
  assert.match(source, /baselineRows:\s*defenseBaseline/, "baseline 을 실제로 넘겨야 한다");
});

check("★ 원장 파일이 산출물과 **같은 promote payload** 에 실린다", () => {
  // 자체발견: 단순 문자열 검사로는 promote 에서 뺀 변이를 못 잡았다 —
  // 경로 상수는 파일 위쪽에 그대로 남아있어 정규식이 계속 맞기 때문이다.
  // 그래서 artifacts 배열 안에 실제로 들어가는지를 본다.
  const source = readFileSync("scripts/crawl-stats.mjs", "utf8");
  const artifactsBlock = source.match(/const artifacts = \[([\s\S]*?)\n {4}\];/);
  assert.ok(artifactsBlock, "artifacts 배열을 찾지 못했다");
  assert.match(
    artifactsBlock[1],
    /rowLedgerPath/,
    "원장을 따로 쓰면 검증 실패로 산출물만 롤백되고 원장만 올라간다",
  );
});

check("★ 오라클이 원장을 **payload 파생**으로 받는다(caller 주입 아님)", () => {
  const source = readFileSync("scripts/lib/verified-promote.mjs", "utf8");
  assert.match(
    source,
    /rowLedger:\s*readJson\("-row-ledger\.json"\)/,
    "context 로 받으면 한 줄로 빈 원장·무제한 원장을 넣을 수 있다",
  );
  // 비어있는 원장은 정상이지만 아예 없는 건 실패다.
  assert.match(source, /key === "rowLedger"/);
});

check("★ 원장 파일이 workflow allowlist 에 들어있다(없으면 첫 PR 이 무조건 auto-merge HOLD)", () => {
  const workflow = readFileSync(".github/workflows/update-roster-stats.yml", "utf8");
  const allowlist = workflow.match(/ALLOWLIST_RE='([^']+)'/);
  assert.ok(allowlist, "ALLOWLIST_RE 를 찾지 못했다");
  // 정규식을 직접 태운다 — 문자열 포함 검사는 괄호 위치가 틀려도 통과한다.
  const re = new RegExp(allowlist[1]);
  assert.ok(
    re.test("src/lib/constants/stats-2026-defense-row-ledger.json"),
    "원장 파일이 allowlist 밖이면 자동 머지가 영구히 보류된다",
  );
  assert.ok(re.test("src/lib/constants/stats-2026-defense.json"), "기존 항목 무회귀");
  assert.ok(!re.test("src/app/page.tsx"), "allowlist 가 너무 넓어지면 안 된다");
});

check("오라클이 행 집합 실패일 때만 확인 재조회하고, 최초 관측을 산입한다", () => {
  const source = readFileSync("scripts/lib/stats-source-truth.mjs", "utf8");
  assert.match(
    source,
    /result\.rowSetFailures\s*>\s*0/,
    "정상 런에서 무조건 N배 조회하면 게이트를 끄자는 압력이 생긴다",
  );
  assert.match(source, /priorObservations:\s*\[spec\.kbo\]/, "최초 관측을 버리면 증거가 사라진다");
  assert.match(source, /carriedFailures/, "최초의 값 실패를 보존해야 한다");
  assert.match(source, /describeValueConflicts/, "오라클도 값 충돌을 fail-close 해야 한다");
});

await Promise.all(pending);

console.log(`\n✅ source row stability: ${passed} PASS`);
