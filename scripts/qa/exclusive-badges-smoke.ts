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
import {
  cleanupDisposableBadgeUser,
  cleanupStageForRequest,
} from "./badge-write-cleanup.mjs";

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

const cleanupStages = [
  "badge-delete",
  "profile-delete",
  "badge-postcondition",
  "profile-postcondition",
  "auth-delete",
  "auth-postcondition",
] as const;

function cleanResponse(stage: string) {
  if (stage === "auth-postcondition") return { status: 404, ok: false, text: "not found", json: null };
  if (stage.endsWith("postcondition")) return { status: 200, ok: true, text: "[]", json: [] };
  return { status: 204, ok: true, text: "", json: null };
}

async function assertCleanupFailureMatrix() {
  for (const targetStage of cleanupStages) {
    for (const mode of ["throw", "non2xx"] as const) {
      const calls = new Map<string, number>();
      const client = (kind: "rest" | "auth") => async (path: string, options: { method?: string } = {}) => {
        const stage = cleanupStageForRequest(kind, path, options.method);
        assert.ok(stage, `unexpected cleanup request: ${kind} ${options.method || "GET"} ${path}`);
        const count = (calls.get(stage) || 0) + 1;
        calls.set(stage, count);
        if (stage === targetStage && count === 1) {
          if (mode === "throw") throw new Error(`injected ${stage} fetch failure`);
          return { status: 503, ok: false, text: `injected ${stage} non-2xx`, json: null };
        }
        return cleanResponse(stage);
      };

      const cleanup = await cleanupDisposableBadgeUser({
        userId: "offline-user",
        key: "offline-service-key",
        rest: client("rest"),
        auth: client("auth"),
      });

      assert.equal(calls.get(targetStage), 2, `${targetStage} ${mode} retries once`);
      for (const stage of cleanupStages) {
        assert.ok((calls.get(stage) || 0) >= 1, `${targetStage} ${mode} still reaches ${stage}`);
      }
      assert.deepEqual(
        { badges: cleanup.badgeCount, profile: cleanup.profileCount, auth: cleanup.authCount },
        { badges: 0, profile: 0, auth: 0 },
        `${targetStage} ${mode} cleanup reaches 0/0/0`
      );
      assert.ok(cleanup.failures.length >= 1, `${targetStage} ${mode} remains RED after successful retry`);
    }
  }
}

assertCleanupFailureMatrix()
  .then(() => console.log("exclusive badges smoke: PASS (UI/RLS mutation RED + cleanup throw/non-2xx fail-close)"))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
