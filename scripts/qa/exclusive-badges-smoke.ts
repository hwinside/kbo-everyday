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

// ⚠️ 이 가드의 이전 판본은 false-green 이었다(삼순 post-merge NO-GO 2026-08-03).
// max-w-lg(512px) 만 가정해 "어절당 8자 안전" 으로 계산했지만, 실제 모바일 4열
// 카드의 텍스트 폭은 320px 에서 ~37px(한글 3.7자)다. 그래서 `전속가수`(4자)가
// Production 에서 `전속/가수` 로 쪼개졌는데도 이 smoke 는 GREEN 이었다.
//
// 소스 문자열로는 실제 줄바꿈을 알 수 없으므로(=이 사고의 교훈),
// 렌더 검증은 scripts/qa/badge-card-wordwrap-browser.mjs (320/360/375/390px 실제
// Chromium line box + computed font-size 측정)이 맡는다.
// 여기서는 소스로 확실히 잠글 수 있는 두 가지만 본다.
//
// ⚠️ 이 가드의 직전 판본은 `fontSize: clamp(...cqw...)` 와 `containerType` 을 **요구**했다.
// 그런데 실측 결과 `clamp(8px, 2.6cqw, 10px)` 는 320~512px 전 구간이 하한 8px 에 고정되어
// 반응형이 아니었고, 데스크톱까지 배지명을 20% 축소하는 가독성 회귀였다(삼순 NO-GO).
// 실효 수정은 폰트 축소가 아니라 좁은 폭에서 열 수를 줄여 칸 폭을 넓히는 것이다.
// 그래서 계약을 뒤집는다 — 폰트는 10px 고정을 강제하고, 반응형 열 수를 요구한다.

// (1) 배지명 폰트는 축소하지 않는다. cqw 기반 축소 재도입을 막는다.
assert.match(
  tabSource,
  /fontSize: "10px",/,
  "badge name font must stay 10px (cqw 축소는 전 구간 하한 고정 + 가독성 회귀였다)"
);
assert.doesNotMatch(
  tabSource,
  /fontSize: "clamp\([^"]*cqw[^"]*\)"/,
  "badge name must not shrink with cqw (실측상 반응형이 아니라 상수 하한이 된다)"
);

// (2) 좁은 폭에서는 열 수를 줄여 어절이 들어갈 공간 자체를 만든다.
const gridMatch = tabSource.match(/grid grid-cols-3 min-\[(\d+)px\]:grid-cols-4 gap-3/);
assert.ok(gridMatch, "badge grid must be responsive (좁은 폭 3열 → 넓은 폭 4열)");
// 4열 전환을 360px 로 두면 360px 실측 여유가 0.5px 뿐이라 폰트가 조금만 넓어도 다시 깨진다.
assert.ok(
  Number(gridMatch[1]) >= 390,
  `4열 전환 breakpoint 는 390px 이상이어야 한다 (현재 ${gridMatch[1]}px, 360px 는 여유 0.5px)`
);

const rlsMigration = readFileSync(
  "supabase/migrations/20260803001500_user_badges_service_role_writes.sql",
  "utf8"
);
assert.match(rlsMigration, /DROP POLICY IF EXISTS "Users earn badges"/i, "legacy self-award policy removed");
assert.match(rlsMigration, /REVOKE INSERT, UPDATE, DELETE[\s\S]*FROM authenticated/i, "authenticated badge writes revoked");
assert.match(rlsMigration, /service.role/i, "trusted service-role award path documented");

console.log("exclusive badges smoke: PASS (UI visibility / founder additive / exclusive RLS contract)");
