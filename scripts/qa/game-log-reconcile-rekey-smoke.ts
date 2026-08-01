/** 경기별 승인표 rekey + 동명이인 fail-close 회귀. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planStaleReconciliation } from "@/lib/game-logs/reconcile";
import type { CanonicalRowInput } from "@/lib/game-logs/completeness";

const base: CanonicalRowInput = {
  game_id: "20260430SSOB0", game_date: "2026-04-30",
  team_id: 8, team_code: "SS", opponent_team_id: 4, is_home: false, result: "W",
  ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, so: 0,
  ip_outs: 0, er: 0, h_allowed: 0, k: 0, bb_allowed: 0,
};
const pitcher = (kboId: string, over: Partial<CanonicalRowInput> = {}): CanonicalRowInput =>
  ({ ...base, kbo_id: kboId, player_type: "pitcher", ...over });
const batter = (kboId: string, over: Partial<CanonicalRowInput> = {}): CanonicalRowInput =>
  ({ ...base, kbo_id: kboId, player_type: "batter", ab: 4, h: 1, ...over });
const keep = batter("__keep__");

let pass = 0;
const fail: string[] = [];
function check(label: string, fn: () => void) {
  try { fn(); pass++; console.log(`  ✓ ${label}`); }
  catch (error) { fail.push(label); console.log(`  ✗ ${label}\n      ${(error as Error).message}`); }
}
function expectRefusal(before: CanonicalRowInput[], expected: CanonicalRowInput[], reason = "no_rekey_counterpart") {
  const plan = planStaleReconciliation(before, before, expected, 0);
  assert.equal(plan.refusal, reason);
  assert.equal(plan.deletions.length, 0);
}

console.log("game-log reconcile 경기별 승인표 회귀");

check("allowlist 승인 한 줄 제거 mutation은 회귀에서 RED", () => {
  const source = readFileSync("src/lib/game-logs/reconcile.ts", "utf8");
  for (const gameId of ["20260430SSOB0", "20260505WOSS0", "20260512SSLG0", "20260517HTSS0"]) {
    assert.match(source, new RegExp(`"${gameId}\\\\u0000pitcher\\\\u000065040\\\\u000062360"`));
  }
});

check("승인된 20260430SSOB0 65040→62360만 삭제 허용", () => {
  const before = [pitcher("65040", { ip_outs: 0 }), keep];
  const expected = [pitcher("62360", { ip_outs: 3 }), pitcher("AQ003", { ip_outs: 2 }), keep];
  const plan = planStaleReconciliation(before, before, expected, 0);
  assert.equal(plan.refusal, null);
  assert.deepEqual(plan.deletions.map((row) => row.kbo_id), ["65040"]);
});

for (const game_id of ["20260505WOSS0", "20260512SSLG0", "20260517HTSS0"]) {
  check(`승인된 ${game_id} 65040→62360 허용`, () => {
    const oldRow = pitcher("65040", { game_id, ip_outs: 0 });
    const newRow = pitcher("62360", { game_id, ip_outs: 3 });
    const kept = batter("__keep__", { game_id });
    const plan = planStaleReconciliation([oldRow, kept], [oldRow, kept], [newRow, kept], 0);
    assert.equal(plan.refusal, null);
    assert.equal(plan.deletions.length, 1);
  });
}

check("allowlist 밖 동일 ID쌍은 fail-close", () => {
  const before = [pitcher("65040", { game_id: "20260518HTSS0" }), keep];
  const expected = [pitcher("62360", { game_id: "20260518HTSS0", ip_outs: 3 }), keep];
  expectRefusal(before, expected);
});
check("allowlist 역방향은 fail-close", () => {
  expectRefusal([pitcher("62360"), keep], [pitcher("65040", { ip_outs: 3 }), keep]);
});
check("allowlist 1→다 후보 중 승인되지 않은 AQ003은 독립 행", () => {
  const before = [pitcher("65040"), keep];
  const expected = [pitcher("62360", { ip_outs: 3 }), pitcher("AQ003", { ip_outs: 2 }), keep];
  const plan = planStaleReconciliation(before, before, expected, 0);
  assert.equal(plan.refusal, null);
  assert.equal(plan.deletions.length, 1);
  assert.equal(expected.filter((row) => row.kbo_id === "AQ003").length, 1);
});
check("unknown ID는 fail-close", () => {
  expectRefusal([pitcher("unknown"), keep], [pitcher("other", { ip_outs: 3 }), keep]);
});

for (const [oldId, newId, label] of [
  ["56709", "52731", "한화 박준영"],
  ["60146", "51454", "삼성 이승현"],
] as const) {
  check(`${label} 동명이인 누락+added/변경에도 삭제 0`, () => {
    expectRefusal(
      [pitcher(oldId, { ip_outs: 3 }), keep],
      [pitcher(newId, { ip_outs: 5 }), keep],
    );
  });
}

check("지문 1:1 exact 경로는 기존대로 유지", () => {
  const before = [pitcher("old", { ip_outs: 3 }), keep];
  const expected = [pitcher("new", { ip_outs: 3 }), keep];
  const plan = planStaleReconciliation(before, before, expected, 0);
  assert.equal(plan.refusal, null);
  assert.equal(plan.deletions.length, 1);
});
check("unresolved는 승인표보다 우선해 fail-close", () => {
  const before = [pitcher("65040"), keep];
  const expected = [pitcher("62360", { ip_outs: 3 }), keep];
  assert.equal(planStaleReconciliation(before, before, expected, 1).refusal, "unresolved_present");
});

console.log(`\n결과: ${pass} pass / ${fail.length} fail`);
if (fail.length > 0) { console.error(`실패: ${fail.join(", ")}`); process.exit(1); }
