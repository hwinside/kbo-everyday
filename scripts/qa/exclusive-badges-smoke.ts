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

const exclusiveIds = ["chairman", "chairman-spouse"];
const expected = {
  chairman: { name: "크보팬 회장", icon: "🏛️" },
  "chairman-spouse": { name: "크보팬 회장남편", icon: "🎩" },
};

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

const bothCatalog = getVisibleBadgeCatalog(new Set(exclusiveIds));
assert.equal(bothCatalog.length, BADGES.length + 2, "multiple exclusive badges count exactly once");
assert.equal(new Set(bothCatalog.map(badge => badge.id)).size, bothCatalog.length, "catalog has no duplicates");

const profileSource = readFileSync("src/app/(main)/profile/[userId]/page.tsx", "utf8");
assert.match(profileSource, /\{founderBadge && \(\s*<span[^>]+aria-label="파운더">👑<\/span>/, "founder crown remains additive");
assert.doesNotMatch(profileSource, /chairmanBadge \? \([\s\S]{0,300}aria-label="파운더"/, "chairman must not replace founder crown");
assert.match(profileSource, />🏛️ 크보팬 회장<\/span>/, "chairman pill rendered");
assert.match(profileSource, />🎩 크보팬 회장남편<\/span>/, "chairman-spouse pill rendered");

const tabSource = readFileSync("src/components/profile/BadgesTab.tsx", "utf8");
assert.match(tabSource, /getVisibleBadgeCatalog\(earnedBadgeIds\)/, "grid uses owner-aware catalog");
assert.match(tabSource, /badges\.filter\(b => visibleBadgeIds\.has\(b\.badge_id\)\)/, "earned count uses same visible catalog");
assert.match(tabSource, /\{visibleBadges\.length\}개 중/, "denominator uses same visible catalog");
assert.doesNotMatch(tabSource, /\{BADGES\.length[^}]*\}개 중/, "global denominator cannot expose hidden slots");

const rlsMigration = readFileSync(
  "supabase/migrations/20260803001500_user_badges_service_role_writes.sql",
  "utf8"
);

function assertRlsMigrationContract(source: string) {
  assert.match(source, /DROP POLICY IF EXISTS "Users earn badges"/i, "legacy self-award policy removed");
  assert.match(source, /REVOKE INSERT, UPDATE, DELETE\s+ON public\.user_badges FROM anon/i, "anon badge writes revoked");
  assert.match(source, /REVOKE INSERT, UPDATE, DELETE\s+ON public\.user_badges FROM authenticated/i, "authenticated badge writes revoked");
  assert.doesNotMatch(source, /REVOKE[^;]*SELECT[^;]*ON public\.user_badges/i, "public badge SELECT retained");
  assert.doesNotMatch(source, /DROP POLICY[^;]*"Anyone reads badges"/i, "public badge read policy retained");
  assert.match(source, /service.role/i, "trusted service-role award path documented");
}

assertRlsMigrationContract(rlsMigration);

const withoutAnonRevoke = rlsMigration.replace(
  /REVOKE INSERT, UPDATE, DELETE\s+ON public\.user_badges FROM anon;?/i,
  ""
);
assert.throws(
  () => assertRlsMigrationContract(withoutAnonRevoke),
  /anon badge writes revoked/,
  "removing anon REVOKE must turn the static gate RED"
);

const withoutPublicRead = `${rlsMigration}\nDROP POLICY IF EXISTS "Anyone reads badges" ON public.user_badges;\n`;
assert.throws(
  () => assertRlsMigrationContract(withoutPublicRead),
  /public badge read policy retained/,
  "dropping public SELECT policy must turn the static gate RED"
);

console.log("exclusive badges smoke: PASS (UI visibility / founder additive / exclusive RLS contract + mutation RED)");
