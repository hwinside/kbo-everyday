import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import roster from "../../src/lib/constants/players-roster.json";
import inventoryJson from "../../data/baseball-qa/source-inventory.json";
import {
  KBO_STRUCTURED_SOURCES,
  NAMU_CORE_SOURCES,
  buildSourceInventory,
  inventoryCoverage,
  selectDemandOrderedIngestionBatch,
  type RagSourceInventory,
  type RosterSourcePlayer,
} from "../../src/lib/baseball-qa/source-inventory";

const inventory = inventoryJson as RagSourceInventory;
const rebuilt = buildSourceInventory(roster as RosterSourcePlayer[], inventory);

assert.equal(roster.length, 878, "roster SSOT count changed; inventory contract must be reviewed");
assert.equal(KBO_STRUCTURED_SOURCES.length, 39, "KBO navigation universe is an independent fixed contract");
assert.equal(inventory.sources.length, 878 + 11 + 39);
assert.equal(rebuilt.inventoryVersion, inventory.inventoryVersion, "inventory generation must be idempotent");
assert.deepEqual(rebuilt, inventory, "committed inventory must match the deterministic generator");

const playerSources = inventory.sources.filter((source) => source.entityType === "player");
assert.equal(playerSources.length, 878);
assert.equal(new Set(playerSources.map((source) => source.entityId)).size, 878);
assert.equal(new Set(playerSources.map((source) => source.sourceKey)).size, 878);
for (const source of playerSources) {
  assert.equal(source.candidateUrls.length, 3);
  assert.equal(source.canonicalUrl, null, "unverified player URL must not be called canonical");
  assert.equal(source.resolutionStatus, null, "unverified player must remain pending, not falsely resolved");
}

assert.equal(NAMU_CORE_SOURCES.length, 11);
for (const source of NAMU_CORE_SOURCES) {
  assert.equal(source.resolutionStatus, "resolved");
  assert.match(source.canonicalUrl ?? "", /^https:\/\/namu\.wiki\/w\//);
}
const kt = NAMU_CORE_SOURCES.find((source) => source.sourceKey === "namu:team:3");
assert.equal(kt?.pageTitle, "kt wiz");
assert.equal(kt?.canonicalUrl, "https://namu.wiki/w/kt%20wiz");
assert.ok(kt?.candidateUrls.some((url) => url.includes("KT%20%EC%9C%84%EC%A6%88")));

const requiredKboPaths = [
  "/Record/Player/HitterBasic/Basic2.aspx",
  "/Record/Player/HitterBasic/Detail1.aspx",
  "/Record/Player/PitcherBasic/Basic2.aspx",
  "/Record/Player/PitcherBasic/Detail1.aspx",
  "/Record/Player/Defense/Basic.aspx",
  "/Record/Player/Runner/Basic.aspx",
  "/Record/Team/Pitcher/Basic2.aspx",
  "/Record/Team/Defense/Basic.aspx",
  "/Record/Crowd/GraphTeam.aspx",
  "/Record/Etc/HitVsPit.aspx",
  "/Record/History/Top/Hitter.aspx",
  "/Record/TeamRank/TeamRankDaily.aspx",
];
const kboUrls = new Set(KBO_STRUCTURED_SOURCES.flatMap((source) => source.candidateUrls));
for (const path of requiredKboPaths) {
  assert.ok(kboUrls.has(`https://www.koreabaseball.com${path}`), `KBO universe missing ${path}`);
}
for (const source of KBO_STRUCTURED_SOURCES) {
  assert.equal(source.sourceGrade, "tier1");
  assert.equal(source.metadata.embeddingAllowed, false);
  assert.match(source.canonicalUrl ?? "", /^https:\/\/www\.koreabaseball\.com\/Record\//);
}

const prior = structuredClone(inventory);
const priorPlayer = prior.sources.find((source) => source.entityType === "player")!;
Object.assign(priorPlayer, {
  canonicalUrl: "https://namu.wiki/w/old",
  resolutionStatus: "resolved",
  ingestionStatus: "ready",
  revision: "old-revision",
  contentHash: "old-hash",
});
const renamedRoster = (roster as RosterSourcePlayer[]).map((player) =>
  player.kboId === priorPlayer.entityId ? { ...player, name: `${player.name} 변경` } : player);
const identityDrift = buildSourceInventory(renamedRoster, prior);
const resetPlayer = identityDrift.sources.find((source) => source.sourceKey === priorPlayer.sourceKey)!;
assert.equal(resetPlayer.canonicalUrl, null);
assert.equal(resetPlayer.resolutionStatus, null);
assert.equal(resetPlayer.ingestionStatus, "not_started");
assert.equal(resetPlayer.revision, null);
assert.equal(resetPlayer.contentHash, null);
assert.notEqual(resetPlayer.identityFingerprint, priorPlayer.identityFingerprint);
assert.notEqual(identityDrift.inventoryVersion, inventory.inventoryVersion);

const classifiedPrior = structuredClone(inventory);
const classifiedPlayer = classifiedPrior.sources.find((source) => source.entityType === "player")!;
classifiedPlayer.canonicalUrl = classifiedPlayer.candidateUrls[0];
classifiedPlayer.resolutionStatus = "resolved";
const classified = buildSourceInventory(roster as RosterSourcePlayer[], classifiedPrior);
assert.notEqual(classified.inventoryVersion, inventory.inventoryVersion,
  "classification/canonical changes must advance inventoryVersion");

const coverage = inventoryCoverage(inventory);
assert.deepEqual(coverage, {
  total: 878,
  counts: { resolved: 0, missing: 0, ambiguous: 0, blocked: 0, pending: 878 },
  classificationComplete: false,
});

const demandFixture = NAMU_CORE_SOURCES.slice(0, 3).map((source, index) => ({
  ...source,
  questionCount: [3, 20, 20][index],
  lastQuestionAt: ["2026-07-31T01:00:00Z", "2026-07-31T02:00:00Z", "2026-07-31T03:00:00Z"][index],
}));
assert.deepEqual(
  selectDemandOrderedIngestionBatch(demandFixture, 3).map((source) => source.sourceKey),
  [demandFixture[2].sourceKey, demandFixture[1].sourceKey, demandFixture[0].sourceKey],
  "embedding/refresh batch must follow question demand then recency",
);

const migration = readFileSync(
  "supabase/migrations/20260731_baseball_genius_rag_sources.sql",
  "utf8",
);
for (const contract of [
  "resolution_status IN ('resolved', 'missing', 'ambiguous', 'blocked')",
  "resolution_status IS DISTINCT FROM 'resolved' OR canonical_url IS NOT NULL",
  "source.ingestion_attempts < 3",
  "source.claim_token = p_claim_token",
  "source.claim_generation = p_claim_generation",
  "source_kind text NOT NULL DEFAULT 'namu_document' CHECK (source_kind = 'namu_document')",
  "(source_kind = 'kbo_structured' AND source_grade = 'tier1')",
  "content_chars integer GENERATED ALWAYS AS (char_length(content)) STORED",
  "char_length(content) BETWEEN 40 AND 900",
  "document_content_hash text NOT NULL",
  "as_of date NOT NULL",
  "invalidate_baseball_genius_rag_identity_drift",
  "source.question_count DESC, source.last_question_at DESC NULLS LAST, source.source_key",
  "embedding extensions.vector(768)",
  "ENABLE ROW LEVEL SECURITY",
  "FROM PUBLIC, anon, authenticated",
]) {
  assert.ok(migration.includes(contract), `migration contract missing: ${contract}`);
}

const seed = readFileSync(
  "supabase/migrations/20260731_baseball_genius_rag_sources_seed.sql",
  "utf8",
);
assert.equal((seed.match(/^  \('/gm) ?? []).length, 928);
assert.ok(seed.includes("ON CONFLICT (source_key) DO UPDATE"));
assert.ok(seed.includes("target.identity_fingerprint = EXCLUDED.identity_fingerprint"));

const spec = readFileSync("specs/baseball-genius-v2-hybrid-rag.md", "utf8");
assert.ok(spec.includes("선수 878명 URL inventory는 전수 확정·유지"));
assert.ok(spec.includes("실제 질문 조회 빈도 내림차순"));
assert.ok(spec.includes("S0 merge·Production DB 적용·실제 계정 2턴 End-User QA HOLD"));
assert.ok(spec.includes("### 12.2 리스크 제안 블록"));

console.log(`baseball QA source inventory PASS (${inventory.sources.length} sources, players ${coverage.total})`);
