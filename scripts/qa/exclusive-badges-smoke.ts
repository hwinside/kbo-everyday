import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACTIVE_BADGE_IDS,
  ALL_BADGES,
  BADGES,
  BADGE_MAP,
  CATEGORY_LABELS,
  EXCLUSIVE_BADGE_IDS,
  RARITY_COLORS,
  getVisibleBadgeCatalog,
} from "../../src/lib/constants/badges";

const exclusiveIds = ["chairman", "chairman-spouse", "keubo-singer"];
const expected = {
  chairman: { name: "크보팬 회장", icon: "🏛️" },
  "chairman-spouse": { name: "크보팬 회장남편", icon: "🎩" },
  "keubo-singer": { name: "크보팬 전속가수", icon: "🎤" },
};

// EXCLUSIVE_BADGE_IDS 와 검증 목록이 벌어지면 신규 한정 배지가 검증 없이 통과한다 — fail-close
assert.deepEqual(
  [...EXCLUSIVE_BADGE_IDS].sort(),
  [...exclusiveIds].sort(),
  "신규 한정 배지를 스모크 검증 목록에도 추가해야 합니다"
);

for (const id of exclusiveIds) {
  const badge = ALL_BADGES.find(candidate => candidate.id === id);
  assert.ok(badge, `${id} definition`);
  assert.deepEqual({ name: badge.name, icon: badge.icon }, expected[id as keyof typeof expected]);
  assert.equal(ACTIVE_BADGE_IDS.has(id), true, `${id} active`);
  assert.equal(EXCLUSIVE_BADGE_IDS.has(id), true, `${id} exclusive`);
  assert.equal(BADGES.some(candidate => candidate.id === id), false, `${id} hidden from base catalog`);
  assert.equal(BADGE_MAP[id]?.id, id, `${id} available to toast/detail consumers`);
  assert.equal(Object.hasOwn(CATEGORY_LABELS, badge.category), true, `${id} category is renderable`);
  assert.equal(Object.hasOwn(RARITY_COLORS, badge.rarity), true, `${id} rarity is renderable`);
}

const emptyCatalog = getVisibleBadgeCatalog(new Set());
assert.equal(emptyCatalog.length, BADGES.length, "non-owner catalog/count unchanged");
assert.equal(emptyCatalog.some(badge => EXCLUSIVE_BADGE_IDS.has(badge.id)), false, "non-owner sees no exclusive slot");

for (const id of exclusiveIds) {
  const catalog = getVisibleBadgeCatalog(new Set([id]));
  assert.equal(catalog.length, BADGES.length + 1, `${id} owner count includes earned exclusive`);
  assert.deepEqual(
    catalog.filter(badge => EXCLUSIVE_BADGE_IDS.has(badge.id)).map(badge => badge.id),
    [id],
    `${id} owner sees only earned exclusive`
  );
}

const allExclusiveCatalog = getVisibleBadgeCatalog(new Set(exclusiveIds));
assert.equal(
  allExclusiveCatalog.length,
  BADGES.length + exclusiveIds.length,
  "multiple exclusive badges count exactly once"
);
assert.equal(
  new Set(allExclusiveCatalog.map(badge => badge.id)).size,
  allExclusiveCatalog.length,
  "catalog has no duplicates"
);

// 한 종류만 보유한 사람은 다른 한정 배지 슬롯을 볼 수 없어야 한다
for (const id of exclusiveIds) {
  const others = exclusiveIds.filter(other => other !== id);
  const catalogIds = new Set(getVisibleBadgeCatalog(new Set([id])).map(badge => badge.id));
  for (const other of others) {
    assert.equal(catalogIds.has(other), false, `${id} owner must not see ${other} slot`);
  }
}

const profileSource = readFileSync("src/app/(main)/profile/[userId]/page.tsx", "utf8");
assert.match(profileSource, /\{founderBadge && \(\s*<span[^>]+aria-label="파운더">👑<\/span>/, "founder crown remains additive");
assert.doesNotMatch(profileSource, /chairmanBadge \? \([\s\S]{0,300}aria-label="파운더"/, "chairman must not replace founder crown");
assert.match(profileSource, />🏛️ 크보팬 회장<\/span>/, "chairman pill rendered");
assert.match(profileSource, />🎩 크보팬 회장남편<\/span>/, "chairman-spouse pill rendered");
assert.match(profileSource, />🎤 크보팬 전속가수<\/span>/, "keubo-singer pill rendered");

const tabSource = readFileSync("src/components/profile/BadgesTab.tsx", "utf8");
assert.match(tabSource, /getVisibleBadgeCatalog\(earnedBadgeIds\)/, "grid uses owner-aware catalog");
assert.match(tabSource, /badges\.filter\(b => visibleBadgeIds\.has\(b\.badge_id\)\)/, "earned count uses same visible catalog");
assert.match(tabSource, /\{visibleBadges\.length\}개 중/, "denominator uses same visible catalog");
assert.doesNotMatch(tabSource, /\{BADGES\.length[^}]*\}개 중/, "global denominator cannot expose hidden slots");

// 배지명은 어절 단위로만 줄바꿈되어야 한다.
// (기본값이면 "크보팬 회장남편" → "크보팬 회 / 장남편" 처럼 낱자 중간에서 쪼개진다 — 실기기 스크린샷 증거)
assert.match(tabSource, /wordBreak:\s*"keep-all"/, "badge name must break on word boundaries");
assert.match(tabSource, /overflowWrap:\s*"break-word"/, "long unbroken tokens must not overflow the card");

// 개행 단위가 카드 폭을 넘지 않는지 — 한정 배지명의 최장 어절 길이 가드.
// 카드 내부 폭 ≈ (max-w-lg 512 - px-5 40 - GlassCard p-4 32 - gap-3 36) / 4 - p-2 16 ≈ 85px,
// 10px 볼드 한글 1자 ≈ 10px → 어절당 8자까지 안전.
for (const id of exclusiveIds) {
  const badge = BADGE_MAP[id];
  for (const word of badge.name.split(" ")) {
    assert.ok(
      word.length <= 8,
      `${id} 배지명의 어절 "${word}"이 길어 카드에서 잘립니다(${word.length}자). 어절을 나누거나 짧게 지으세요`
    );
  }
}

const rlsMigration = readFileSync(
  "supabase/migrations/20260803001500_user_badges_service_role_writes.sql",
  "utf8"
);
assert.match(rlsMigration, /DROP POLICY IF EXISTS "Users earn badges"/i, "legacy self-award policy removed");
assert.match(rlsMigration, /REVOKE INSERT, UPDATE, DELETE[\s\S]*FROM authenticated/i, "authenticated badge writes revoked");
assert.match(rlsMigration, /service.role/i, "trusted service-role award path documented");

console.log("exclusive badges smoke: PASS (UI visibility / founder additive / exclusive RLS contract)");
