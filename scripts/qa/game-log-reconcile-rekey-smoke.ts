/**
 * player_game_logs stale key reconciliation — 이름 동일성 rekey 경로 회귀.
 *
 * 사고(2026-08-01 실측): 선수 재식별 시 스탯까지 같이 바뀌거나 과거에 두 선수가 한 ID로
 * 뭉쳐 있다가 분리되면(1→2), "kbo_id만 다르고 나머지 canonical 필드 전부 exact" 라는
 * 1:1 지문 짝 판정이 깨져 `no_rekey_counterpart` 로 영구 거부됐다.
 * 그 결과 운영 원장 29경기가 백필 재실행으로도 복구 불가 상태가 되고,
 * 직관 통계의 팀 타율·ERA·홈런·최애 기록이 전부 `일부 기록 확인 중` 으로 막혔다.
 *
 * 이 회귀가 고정하는 계약:
 *   [효과]  지문 짝이 없어도 "같은 이름·같은 자리"의 added 가 있으면 삭제 허용(재식별 인정)
 *   [방어]  공급자 부분 응답(설명할 added 없음)은 여전히 삭제 0 + fail-closed  ← 삼순 P0 핵심
 *   [순서]  지문 짝이 존재하면 종전 판정을 그대로 쓴다(모호하면 거부) — 완화가 덮어쓰지 않는다
 *   [근거]  로스터에 이름이 없는 ID 는 재식별 근거가 없으므로 설명으로 인정하지 않는다
 */
import assert from "node:assert/strict";
import { planStaleReconciliation } from "@/lib/game-logs/reconcile";
import type { CanonicalRowInput } from "@/lib/game-logs/completeness";
import playersRoster from "@/lib/constants/players-roster.json";

const roster = playersRoster as Array<{ kboId?: string; name?: string }>;
/** 로스터에서 "같은 이름 · 다른 kboId" 실제 쌍을 찾는다(가공 fixture 아님). */
function findRealRenamePair(): { name: string; oldId: string; newId: string } {
  const byName = new Map<string, string[]>();
  for (const p of roster) {
    if (!p.kboId || !p.name) continue;
    byName.set(p.name, [...(byName.get(p.name) ?? []), String(p.kboId)]);
  }
  for (const [name, ids] of byName) {
    if (ids.length >= 2) return { name, oldId: ids[0], newId: ids[1] };
  }
  throw new Error("동명 kboId 쌍을 로스터에서 찾지 못함");
}

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

let pass = 0;
const fail: string[] = [];
function check(label: string, fn: () => void) {
  try { fn(); pass++; console.log(`  ✓ ${label}`); }
  catch (e) { fail.push(label); console.log(`  ✗ ${label}\n      ${(e as Error).message}`); }
}

const { name: renameName, oldId, newId } = findRealRenamePair();
console.log(`game-log reconcile rekey 회귀 (로스터 실쌍: ${renameName} ${oldId}↔${newId})`);

console.log("\n[효과] 스탯이 함께 바뀐 재식별");
check("스탯 변동(ip_outs 3→5)이어도 같은 이름이면 삭제 허용", () => {
  const before = [pitcher(oldId, { ip_outs: 3 }), batter("__keep__")];
  const expected = [pitcher(newId, { ip_outs: 5 }), batter("__keep__")];
  const plan = planStaleReconciliation(before, before, expected, 0);
  assert.equal(plan.refusal, null, `refusal=${plan.refusal}`);
  assert.equal(plan.deletions.length, 1);
  assert.equal(String(plan.deletions[0].kbo_id), oldId);
});

check("1→2 분리(한 ID가 두 선수로 갈라짐)도 같은 이름 짝이 있으면 허용", () => {
  const before = [pitcher(oldId, { ip_outs: 0 }), batter("__keep__")];
  // 재식별된 본인 + 원래 섞여 있던 다른 투수가 함께 등장한다.
  const expected = [pitcher(newId, { ip_outs: 1 }), pitcher("__other__", { ip_outs: 2 }), batter("__keep__")];
  const plan = planStaleReconciliation(before, before, expected, 0);
  assert.equal(plan.refusal, null, `refusal=${plan.refusal}`);
  assert.equal(plan.deletions.length, 1);
});

console.log("\n[방어] 부분 응답은 여전히 거부 (삼순 P0)");
check("설명할 added 가 없으면 no_rekey_counterpart (선수 1명 누락)", () => {
  const before = [pitcher(oldId), batter("__keep__")];
  const expected = [batter("__keep__")]; // 투수가 통째로 빠진 부분 응답
  const plan = planStaleReconciliation(before, before, expected, 0);
  assert.equal(plan.refusal, "no_rekey_counterpart");
  assert.equal(plan.deletions.length, 0);
});

check("같은 이름이어도 자리(팀)가 다르면 설명으로 인정하지 않는다", () => {
  const before = [pitcher(oldId), batter("__keep__")];
  const expected = [pitcher(newId, { team_id: 1, team_code: "LG" }), batter("__keep__")];
  const plan = planStaleReconciliation(before, before, expected, 0);
  assert.equal(plan.refusal, "no_rekey_counterpart");
  assert.equal(plan.deletions.length, 0);
});

check("같은 이름이어도 player_type 이 다르면 인정하지 않는다", () => {
  const before = [pitcher(oldId), batter("__keep__")];
  const expected = [batter(newId), batter("__keep__")];
  const plan = planStaleReconciliation(before, before, expected, 0);
  assert.equal(plan.refusal, "no_rekey_counterpart");
});

check("로스터에 이름이 없는 stale ID 는 재식별 근거가 없어 거부", () => {
  // 지문까지 같으면 경로 (A) 가 정당하게 처리하므로, 경로 (B) 를 타게 스킯을 달리 둔다.
  const before = [pitcher("__unknown_id__", { ip_outs: 3 }), batter("__keep__")];
  const expected = [pitcher("__other_unknown__", { ip_outs: 5 }), batter("__keep__")];
  const plan = planStaleReconciliation(before, before, expected, 0);
  assert.equal(plan.refusal, "no_rekey_counterpart");
  assert.equal(plan.deletions.length, 0);
});

console.log("\n[순서] 지문 짝이 있으면 종전 판정을 유지한다");
check("동일 지문 후보 복수 → ambiguous_rekey_counterpart (완화가 덮지 않음)", () => {
  const twin = batter("x", { ab: 1, h: 0 });
  const oldA = { ...twin, kbo_id: "70001" };
  const oldB = { ...twin, kbo_id: "70002" };
  const newA = { ...twin, kbo_id: "80001" };
  const newB = { ...twin, kbo_id: "80002" };
  const keep = pitcher("__keep__");
  // persisted 가 stale 만으로 이뤄지면 suspicious_full_delete 가 먼저 걸리므로
  // 기존 s1a fixture 처럼 잔존행을 포함시켜 "모호한 짝" 축만 곬눈다.
  const persisted = [oldA, oldB, keep];
  const plan = planStaleReconciliation(persisted, persisted, [newA, newB, keep], 0);
  assert.equal(plan.refusal, "ambiguous_rekey_counterpart");
  assert.equal(plan.deletions.length, 0);
});

console.log("\n[기존 가드 유지]");
check("unresolved 가 있으면 unresolved_present", () => {
  const before = [pitcher(oldId), batter("__keep__")];
  const expected = [pitcher(newId), batter("__keep__")];
  assert.equal(planStaleReconciliation(before, before, expected, 1).refusal, "unresolved_present");
});
check("기대가 비면 suspicious_full_delete", () => {
  const before = [pitcher(oldId), batter("__keep__")];
  assert.equal(planStaleReconciliation(before, before, [], 0).refusal, "suspicious_full_delete");
});
check("stale 이 없으면 삭제 0 · 거부 없음", () => {
  const rows = [pitcher(oldId), batter("__keep__")];
  const plan = planStaleReconciliation(rows, rows, rows, 0);
  assert.equal(plan.refusal, null);
  assert.equal(plan.deletions.length, 0);
});

console.log(`\n결과: ${pass} pass / ${fail.length} fail`);
if (fail.length > 0) { console.error(`실패: ${fail.join(", ")}`); process.exit(1); }
