/**
 * reconcile-full-shape-verifier.ts 의 **정적 계약** 회귀 (CI 결속, 네트워크/DB 불요).
 *
 * 왜 필요한가 — 삼순 지적:
 *   full-shape verifier 는 운영 자격증명이 있어야 돌아서 CI 에서 실행할 수 없다.
 *   그러면 verifier 안의 가드(pre-backfill gate, partial 우주 중단)가 누가 지워도
 *   CI 는 초록이다. 그래서 "가드가 존재하는가"만이라도 정적으로 못박는다.
 *
 * 여기서 고정하는 것:
 *   ① MIN_SEASON_FINALS 중단 가드 존재 (partial 우주로 판정 금지)
 *   ② --expect 경로에 pre-backfill gate 존재 (대상 game_id 전수 우주 해결 + boxscore 성공)
 *   ③ 거부 경기 부분삭제 0 assert 존재 (atomic)
 *   ④ 삭제 대상 = stale 정확 일치 assert 존재 (멀쩡한 행 삭제 0)
 *   ⑤ verifier 가 production helper 를 직접 쓴다 (알고리즘 복제 금지)
 *   ⑥ verifier 가 쓰기(insert/update/delete/upsert)를 하지 않는다
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertDeletionKeysMatchStaleKeys,
  assertExpectedApprovedHeals,
  EXPECTED_STALE_DELETIONS,
} from "./reconcile-full-shape-assertions";

const SRC = "scripts/qa/reconcile-full-shape-verifier.ts";
const src = readFileSync(SRC, "utf8");

let pass = 0;
const fail: string[] = [];
function check(label: string, fn: () => void) {
  try { fn(); pass++; console.log(`  ✓ ${label}`); }
  catch (error) { fail.push(label); console.log(`  ✗ ${label}\n      ${(error as Error).message}`); }
}

console.log("reconcile full-shape verifier 정적 계약");

check("① partial 우주 중단 가드(MIN_SEASON_FINALS) 존재", () => {
  assert.match(src, /const MIN_SEASON_FINALS\s*=\s*\d+/);
  assert.match(src, /finals\.length\s*<\s*MIN_SEASON_FINALS/);
  assert.match(src, /throw new Error\(/);
});

check("② --expect pre-backfill gate: 대상 전수 우주 해결 + boxscore 성공", () => {
  assert.match(src, /unresolvable/, "미해결 목록을 모으지 않는다");
  assert.match(
    src,
    /unresolvable\.push\(`\$\{gameId\}: 필수 필드 누락\(missing_required_field\)`\)/,
    "missing_required_field를 blocking 미해결 목록에 넣지 않는다",
  );
  assert.match(src, /blockingUnresolvable/, "정규 밖 예외를 제외한 blocking 목록이 없다");
  assert.match(
    src,
    /assert\.deepEqual\(\s*blockingUnresolvable,\s*\[\]/,
    "미해결이 하나라도 있으면 중단하는 assert 가 없다",
  );
});

check("③ 거부 경기 부분삭제 0 (atomic) assert 존재", () => {
  assert.match(src, /assert\.deepEqual\(v\.deletions,\s*\[\]/);
});

check("④ 삭제 대상 = stale 정확 일치 assert 존재", () => {
  assert.match(src, /assertDeletionKeysMatchStaleKeys\(v\.gameId, v\.deletions, v\.staleKeys\)/);
  assert.doesNotThrow(() => assertDeletionKeysMatchStaleKeys("G", ["1|batter"], ["1|batter"]));
  assert.throws(
    () => assertDeletionKeysMatchStaleKeys("G", ["__WRONG__|batter"], ["1|batter"]),
    "wrong-key/same-count 결함주입이 RED여야 한다",
  );
});

check("⑤ 승인된 stale 치유 4경기 / exact 삭제 집합 고정", () => {
  assert.equal(Object.keys(EXPECTED_STALE_DELETIONS).length, 4);
  assert.match(src, /assertExpectedApprovedHeals\(/);
  assert.doesNotThrow(() => assertExpectedApprovedHeals(EXPECTED_STALE_DELETIONS));
  const mutated = { ...EXPECTED_STALE_DELETIONS, "20260430SSOB0": ["__WRONG__|pitcher"] };
  assert.throws(() => assertExpectedApprovedHeals(mutated), "승인 4경기 중 한 key 퇴행이 RED여야 한다");
});

check("⑥ production helper 직접 사용 (알고리즘 복제 금지)", () => {
  assert.match(src, /from "@\/lib\/game-logs\/reconcile"/);
  assert.match(src, /planStaleReconciliation\(/);
  assert.match(src, /buildGameIngestion\(/);
});

check("⑦ 읽기 전용 — 쓰기 호출 없음", () => {
  for (const w of [".insert(", ".update(", ".delete(", ".upsert("]) {
    assert.ok(!src.includes(w), `쓰기 호출 발견: ${w}`);
  }
});

check("⑧ package script 로 노출되어 운영 실행 가능", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["qa:reconcile-full-shape"], "qa:reconcile-full-shape 스크립트 없음");
  assert.match(pkg.scripts["qa:reconcile-full-shape"], /reconcile-full-shape-verifier\.ts/);
});

console.log(`\n결과: ${pass} pass / ${fail.length} fail`);
if (fail.length > 0) { console.error(`실패: ${fail.join(", ")}`); process.exit(1); }
