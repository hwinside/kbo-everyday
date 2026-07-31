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
assert.equal(inventory.sources.length, 878 + 11 + KBO_STRUCTURED_SOURCES.length);
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
for (const source of KBO_STRUCTURED_SOURCES) {
  assert.equal(source.sourceGrade, "official");
  assert.equal(source.metadata.embeddingAllowed, false);
  assert.match(source.canonicalUrl ?? "", /^https:\/\/www\.koreabaseball\.com\/Record\//);
}

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
  "source.question_count DESC, source.last_question_at DESC NULLS LAST, source.source_key",
  "embedding extensions.vector",
  "ENABLE ROW LEVEL SECURITY",
  "FROM PUBLIC, anon, authenticated",
]) {
  assert.ok(migration.includes(contract), `migration contract missing: ${contract}`);
}

const spec = readFileSync("specs/baseball-genius-v2-hybrid-rag.md", "utf8");
assert.ok(spec.includes("선수 878명 URL inventory는 전수 확정·유지"));
assert.ok(spec.includes("실제 질문 조회 빈도 내림차순"));

console.log(`baseball QA source inventory PASS (${inventory.sources.length} sources, players ${coverage.total})`);
