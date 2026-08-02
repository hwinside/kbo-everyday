import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACTIVE_BADGE_IDS,
  ALL_BADGES,
  BADGES,
  EXCLUSIVE_BADGE_IDS,
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

console.log("exclusive badges smoke: PASS (2 definitions / owner-only catalog / founder crown additive)");
