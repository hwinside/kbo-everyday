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

// ── 다중 stale full-shape 경계 (삼순 P0) ────────────────────────────────────
// 앞의 fixture 들은 경기당 stale 1건만 놓아 실제 경계를 놓쳤다.
// 운영 20260505WOSS0 의 진짜 shape 은 stale 2건(65040|pitcher, 50167|batter)이고
// 65040 의 지문 후보가 62360·AQ003 두 건(둘 다 ipOuts=3)라 지문 경로만 으로는
// `ambiguous_rekey_counterpart` 로 **전체 atomic reconcile 이 거부**된다.
// 그러면 승인표에 그 한 줄이 있어도 경기가 치유되지 않는다.
check("[full-shape] 20260505WOSS0 다중 stale — 승인표가 지문 ambiguous 보다 우선", () => {
  const g = "20260505WOSS0";
  const staleP = pitcher("65040", { game_id: g, team_code: "SS", ip_outs: 3 });
  const staleB = batter("50167", { game_id: g, team_code: "WO", ab: 4, h: 0 });
  const before = [staleP, staleB, keep];
  const expected = [
    // 기록이 같은 투수 2명 — 지문만으로는 누가 65040 의 재식별인지 못 정한다.
    pitcher("62360", { game_id: g, team_code: "SS", ip_outs: 3 }),
    pitcher("AQ003", { game_id: g, team_code: "SS", ip_outs: 3 }),
    // 50167 → 51302 는 지문 1:1 (승인표 밖 — 종전 경로로 통과해야 함)
    batter("51302", { game_id: g, team_code: "WO", ab: 4, h: 0 }),
    keep,
  ];
  const plan = planStaleReconciliation(before, before, expected, 0);
  assert.equal(plan.refusal, null, "다중 stale 이어도 전부 설명되면 거부하지 않는다");
  assert.deepEqual(
    plan.deletions.map((r) => `${r.kbo_id}|${r.player_type}`).sort(),
    ["50167|batter", "65040|pitcher"],
    "stale 2건 모두 삭제 계획에 포함",
  );
  // AQ003 은 독립 신규 행이지 삭제 대상이 아니다.
  assert.ok(!plan.deletions.some((r) => r.kbo_id === "AQ003"));
});

check("[full-shape] 다중 stale 중 하나라도 설명 안 되면 전체 거부(atomic)", () => {
  const g = "20260505WOSS0";
  const before = [
    pitcher("65040", { game_id: g, team_code: "SS", ip_outs: 3 }),
    // 56709 는 동명이인 박준영 — 승인표 밖이고 지문도 안 맞는다.
    pitcher("56709", { game_id: g, team_code: "SS", ip_outs: 3 }),
    keep,
  ];
  const expected = [
    pitcher("62360", { game_id: g, team_code: "SS", ip_outs: 3 }),
    pitcher("52731", { game_id: g, team_code: "SS", ip_outs: 5 }),
    keep,
  ];
  const plan = planStaleReconciliation(before, before, expected, 0);
  assert.ok(plan.refusal, "설명 안 되는 stale 이 섞이면 거부");
  assert.deepEqual(plan.deletions, [], "거부 시 부분 삭제 0 (atomic)");
});

// ── 승인표 candidate 경계 (삼순 P0) ──────────────────────────────────────
// 승인표 key 에는 stale 쪽의 game_id/player_type 만 들어 있다. candidate 쪽을 검증하지 않으면
// "그 ID 가 어디에든 있으면 삭제"가 되어 승인 범위를 벗어난다.
check("승인표 candidate 의 player_type 이 다르면 fail-close", () => {
  // stale 65040|pitcher 에 대해 expected 에 62360|**batter** 만 있는 경우.
  // 승인한 건 "그 경기 pitcher 역할의 65040→62360" 이지 batter 가 아니다.
  expectRefusal(
    [pitcher("65040", { ip_outs: 3 }), keep],
    [batter("62360"), keep],
  );
});

check("승인표 candidate 가 다른 경기의 행이면 fail-close", () => {
  // 같은 ID 짝이라도 다른 game_id 의 added 행으로는 설명될 수 없다.
  expectRefusal(
    [pitcher("65040", { ip_outs: 3 }), keep],
    [pitcher("62360", { game_id: "20260999XXYY0", ip_outs: 3 }), keep],
  );
});

check("[full-shape] LG 잔여 3경기 패턴(56709/53893)은 여전히 fail-close", () => {
  // 실측: 20260422HHLG0·20260508LGHH0 → 56709|pitcher, 20260609SKLG0 → 53893|pitcher.
  // 이 3건은 이 PR 로 치유되지 **않는다** — 화면 blocker 해소 주장의 근거로 쓰지 못하게 고정.
  expectRefusal(
    [pitcher("56709", { game_id: "20260422HHLG0", team_code: "HH", ip_outs: 3 }), keep],
    [pitcher("52731", { game_id: "20260422HHLG0", team_code: "HH", ip_outs: 5 }), keep],
  );
  expectRefusal(
    [pitcher("56709", { game_id: "20260508LGHH0", team_code: "HH", ip_outs: 3 }), keep],
    [pitcher("52731", { game_id: "20260508LGHH0", team_code: "HH", ip_outs: 5 }), keep],
  );
  expectRefusal(
    [pitcher("53893", { game_id: "20260609SKLG0", team_code: "SK", ip_outs: 9 }), keep],
    [pitcher("51302", { game_id: "20260609SKLG0", team_code: "SK", ip_outs: 6 }), keep],
  );
});

console.log(`\n결과: ${pass} pass / ${fail.length} fail`);
if (fail.length > 0) { console.error(`실패: ${fail.join(", ")}`); process.exit(1); }
