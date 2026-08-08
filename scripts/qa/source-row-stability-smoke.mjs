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
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MIN_CONFIRM_READS,
  assertConfirmReads,
  classifyRowStability,
  describeUnstableRows,
} from "../lib/source-row-stability.mjs";
import { crossCheckDataset } from "../lib/stats-source-truth.mjs";

let passed = 0;
const check = (label, fn) => {
  fn();
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
const cell = (name, pos, games) => ["1", name, "두산", pos, String(games), "", "1", "0", "0", "1", "0", "0", "1.000", "0", "0", "0"];

console.log("\n▸ 관측 접기(classifyRowStability)");

check("전 회차 공통 행 = stable", () => {
  const result = classifyRowStability([
    obs([["1|중견수", cell("가", "중견수", 1)]]),
    obs([["1|중견수", cell("가", "중견수", 1)]]),
  ]);
  assert.deepEqual([...result.stableKeys], ["1|중견수"]);
  assert.equal(result.unstableKeys.size, 0);
});

check("일부 회차만 관측된 행 = unstable (전다민 824↔825 실측 형상)", () => {
  const result = classifyRowStability([
    obs([["54214|좌익수", cell("전다민", "좌익수", 1)]]),
    obs([
      ["54214|좌익수", cell("전다민", "좌익수", 1)],
      ["54214|중견수", cell("전다민", "중견수", 1)],
    ]),
  ]);
  assert.deepEqual([...result.stableKeys], ["54214|좌익수"]);
  assert.deepEqual([...result.unstableKeys], ["54214|중견수"]);
  // union 에는 남는다 — 값 대조 대상이기 때문이다.
  assert.ok(result.union.has("54214|중견수"));
});

throws(
  "관측 0회 = 통과가 아니라 실패",
  () => classifyRowStability([]),
  /row_stability_no_observations/,
);

throws(
  "0행 회차 = '전부 불안정'이 아니라 수집 실패",
  () => classifyRowStability([obs([["1|중견수", cell("가", "중견수", 1)]]), obs([])]),
  /row_stability_empty_observation/,
);

throws(
  "1회 관측으로는 불안정을 판정할 수 없다",
  () => assertConfirmReads(1),
  /row_stability_insufficient_reads/,
);

check("하한 이상은 통과", () => {
  assert.equal(assertConfirmReads(MIN_CONFIRM_READS), MIN_CONFIRM_READS);
});

check("불안정 요약은 조용히 넘기지 않고 문장을 남긴다", () => {
  const note = describeUnstableRows(
    "수비",
    new Set(["54214|중견수"]),
    obs([["54214|중견수", cell("전다민", "중견수", 1)]]),
  );
  assert.match(note, /54214\|중견수/);
  assert.match(note, /전다민/);
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
    kbo: obs([
      ["54214|좌익수", cell("전다민", "좌익수", 1)],
      ["54214|중견수", cell("전다민", "중견수", 1)],
    ]),
    unstableKeys: new Set(["54214|중견수"]),
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.rowSetFailures, 0);
});

check("불안정 행이 우리 쪽에만 있어도 실패가 아니다 (반대 방향)", () => {
  const result = crossCheckDataset({
    ...DEFENSE_SPEC,
    rows: [ours("54214", "좌익수"), ours("54214", "중견수")],
    kbo: obs([["54214|좌익수", cell("전다민", "좌익수", 1)]]),
    unstableKeys: new Set(["54214|중견수"]),
  });
  assert.deepEqual(result.failures, []);
});

check("★ 안정 행 누락은 여전히 실패다 (완화가 전체로 번지지 않는다)", () => {
  const result = crossCheckDataset({
    ...DEFENSE_SPEC,
    rows: [],
    kbo: obs([["99999|포수", cell("타인", "포수", 1)]]),
    unstableKeys: new Set(["54214|중견수"]),
  });
  assert.equal(result.rowSetFailures, 1);
  assert.match(result.failures[0], /KBO에 있으나 우리 데이터에 없음/);
});

check("★ 불안정 행이어도 값 불일치는 그대로 잡는다 (값 대조 완화 없음)", () => {
  const result = crossCheckDataset({
    ...DEFENSE_SPEC,
    rows: [ours("54214", "중견수", 999)],
    kbo: obs([["54214|중견수", cell("전다민", "중견수", 1)]]),
    unstableKeys: new Set(["54214|중견수"]),
  });
  assert.equal(result.rowSetFailures, 0, "행 집합은 통과");
  assert.equal(result.failures.length, 1, "값은 잡혀야 한다");
  assert.match(result.failures[0], /값 불일치.*games.*ours=999/);
});

check("★ unstableKeys 미지정이면 종전과 동일한 strict 판정", () => {
  const result = crossCheckDataset({
    ...DEFENSE_SPEC,
    rows: [],
    kbo: obs([["54214|중견수", cell("전다민", "중견수", 1)]]),
  });
  assert.equal(result.rowSetFailures, 1);
});

check("rowSetFailures 는 값 불일치를 세지 않는다 (재조회 트리거가 값에 반응하면 비용만 N배)", () => {
  const result = crossCheckDataset({
    ...DEFENSE_SPEC,
    rows: [ours("54214", "중견수", 7)],
    kbo: obs([["54214|중견수", cell("전다민", "중견수", 1)]]),
  });
  assert.equal(result.failures.length, 1);
  assert.equal(result.rowSetFailures, 0);
});

console.log("\n▸ 결속(배선이 실제로 살아 있는가)");

check("크롤러 수비 경로가 확인 재조회 하한에 결속돼 있다", () => {
  const source = readFileSync("scripts/crawl-stats.mjs", "utf8");
  assert.match(
    source,
    /DEFENSE_CONFIRM_READS\s*=\s*MIN_CONFIRM_READS/,
    "수비 확인 횟수가 lib 하한과 분리되면 1회로 되돌릴 수 있다",
  );
  assert.match(source, /defense_empty_observation/, "0행 회차 fail-close 가 있어야 한다");
});

check("오라클이 행 집합 실패일 때만 확인 재조회한다", () => {
  const source = readFileSync("scripts/lib/stats-source-truth.mjs", "utf8");
  assert.match(
    source,
    /result\.rowSetFailures\s*>\s*0/,
    "정상 런에서 무조건 N배 조회하면 게이트를 끄자는 압력이 생긴다",
  );
  assert.match(source, /collectKboPagesConfirmed/);
});

console.log(`\n✅ source row stability: ${passed} PASS`);
