// @crawl-managed-read: structural  (크롤 관리 데이터 파일을 구조·불변식 검증에만 사용 — 값 하드코딩 금지, 축② 순환참조 메타게이트)
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

// roster 인원은 콜업·트레이드·외인 교체로 상시 변한다. 여기에 숫자를 하드코딩하면
// 로스터가 1명만 바뀌어도 매일 새벽 자동 PR의 prebuild가 죽어 스탯/로스터 반영이 통째로
// 멈춘다(2026-08-01 카라스코 56103, roster 878→879로 실제 발생). 따라서 고정값이 아니라
// "커밋된 inventory가 현재 roster와 정확히 대응한다"는 *관계*를 계약으로 강제한다.
// (roster 자체의 급변 방어는 자동 크롤 workflow의 main 대비 Δ+ack 가드 소관.)
const ROSTER_COUNT = roster.length;
assert.ok(ROSTER_COUNT > 0, "roster SSOT must not be empty");
assert.equal(KBO_STRUCTURED_SOURCES.length, 43, "KBO navigation universe is an independent fixed contract");
assert.equal(inventory.sources.length, ROSTER_COUNT + NAMU_CORE_SOURCES.length + KBO_STRUCTURED_SOURCES.length);
assert.equal(rebuilt.inventoryVersion, inventory.inventoryVersion, "inventory generation must be idempotent");
assert.deepEqual(rebuilt, inventory, "committed inventory must match the deterministic generator");

const playerSources = inventory.sources.filter((source) => source.entityType === "player");
assert.equal(playerSources.length, ROSTER_COUNT);
assert.equal(new Set(playerSources.map((source) => source.entityId)).size, ROSTER_COUNT);
assert.equal(new Set(playerSources.map((source) => source.sourceKey)).size, ROSTER_COUNT);
// 커밋된 inventory의 선수 집합이 roster SSOT와 exact 일치해야 한다(누락·유령 0).
// 개수만 보면 "한 명 빠지고 한 명 늘어난" drift를 놓친다.
assert.deepEqual(
  [...new Set(playerSources.map((source) => source.entityId))].sort(),
  [...new Set((roster as RosterSourcePlayer[]).map((player) => player.kboId))].sort(),
  "committed inventory player set must match roster SSOT exactly",
);
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
  // 기존 야잘알 공식 seed·프로덕션 코드가 실제로 호출 중인 개인 상세 경로
  // (player-stats·contextual-stats·update-player-photos·backfill-roster-birthdate 등).
  "/Record/Player/HitterDetail/Basic.aspx",
  "/Record/Player/PitcherDetail/Basic.aspx",
  // 은퇴선수 기록(scripts/crawl-* 계열에서 참조). 2026-07-31 HTTP 200 실측.
  "/Record/Retire/Hitter.aspx",
  "/Record/Retire/Pitcher.aspx",
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
  total: ROSTER_COUNT,
  counts: { resolved: 0, missing: 0, ambiguous: 0, blocked: 0, pending: ROSTER_COUNT },
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
  // 실패 종료 RPC는 sources 직접 UPDATE 없이 terminal 전이·last_error 관측을 여는 유일한 경로다.
  // 경계 검증은 PG17 게이트(qa:baseball-source-inventory:db)가 하지만, 그건 prebuild 체인에
  // 없는 수동 게이트라 RPC가 통째로 사라져도 자동 게이트가 녹색이 된다. 존재·ACL만 여기서 고정한다.
  "FUNCTION public.fail_baseball_genius_rag_source(",
  "GRANT EXECUTE ON FUNCTION public.fail_baseball_genius_rag_source(text, uuid, bigint, text) TO service_role;",
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
const bootstrapRows = (seed.match(/^  \('/gm) ?? []).length;
assert.ok(bootstrapRows > 0, "bootstrap seed fixture must not be empty");
assert.ok(seed.includes("ON CONFLICT (source_key) DO UPDATE"));
assert.ok(seed.includes("target.identity_fingerprint = EXCLUDED.identity_fingerprint"));
const rosterDelta = readFileSync(
  "supabase/migrations/20260801184500_baseball_genius_roster_sources_56103.sql",
  "utf8",
);
assert.ok(rosterDelta.includes("namu:player:56103"), "new roster source must ship append-only");
assert.ok(rosterDelta.includes("namu:player:55435"), "transfer metadata delta missing: 55435");
assert.ok(rosterDelta.includes("namu:player:69428"), "transfer metadata delta missing: 69428");

const spec = readFileSync("specs/baseball-genius-v2-hybrid-rag.md", "utf8");
assert.ok(spec.includes("선수 URL inventory는 전수 확정·유지"));
assert.ok(spec.includes("실제 질문 조회 빈도 내림차순"));
assert.ok(spec.includes("S0 merge·Production DB 적용"));
assert.ok(spec.includes("실제 계정 2턴 End-User QA HOLD"));
// 상태줄은 머지된 실제 squash SHA를 exact로 밝혀야 한다(재발 방지).
assert.ok(
  spec.includes("882f1a1744fb9ead6197a133421b347b3836c96a"),
  "spec 상태줄은 머지된 S0 squash SHA를 명시해야 한다",
);
// 변경이력(§11)은 과거 stale 문구를 인용할 수 있으므로 *상태줄 그 자체*만 검사한다.
const specStatusLine = spec.split("\n").find((line) => line.startsWith("> 상태:")) ?? "";
assert.ok(
  !specStatusLine.includes("S0 exact 계약 조건부 GO"),
  "stale 상태줄(S0 조건부 GO)이 남아 있으면 안 된다",
);
assert.ok(
  specStatusLine.includes("882f1a1744fb9ead6197a133421b347b3836c96a"),
  "상태줄 자체에 머지된 S0 squash SHA가 있어야 한다",
);

// §12.2는 '제안·미확정'이 아니라 확정된 기술 게이트다.
assert.ok(spec.includes("### 12.2 수집 기술 게이트"), "§12.2는 확정 기술 게이트로 승격돼야 한다");
assert.ok(
  !spec.includes("### 12.2 리스크 제안 블록"),
  "§12.2가 아직 '제안·미확정' 상태로 남아 있다",
);
// 상업 이용 법무 승인은 inventory 게이트가 아니라 별도 launch gate로 분리·미확정 유지.
assert.ok(spec.includes("decision_pending"), "상업 법무 승인은 decision_pending으로 분리 유지돼야 한다");
assert.ok(spec.includes("launch gate"), "대량 ingestion/서빙 전 별도 launch gate가 명시돼야 한다");

console.log(`baseball QA source inventory PASS (${inventory.sources.length} sources, KBO universe ${KBO_STRUCTURED_SOURCES.length}, players ${coverage.total})`);
