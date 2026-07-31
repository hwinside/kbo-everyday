/**
 * 야잘알봇 v2 Hybrid RAG S2a — 인벤토리/ingestion 스캐폴드 스모크.
 * 실행: npx tsx scripts/qa/genius-rag-inventory-smoke.ts  (npm run qa:genius-rag)
 *
 * 검증 대상(신뢰성 게이트가 코드로 지켜지는지):
 *   1. 인벤토리 전수 커버리지 — 로스터 878명 전원 + 10구단 + KBO 1 + 기록실 범주가 누락 없이 등재
 *   2. 조용한 누락 금지 — 모든 행이 5개 status 중 하나로 분류되고, 동명이인은 ambiguous
 *   3. 신뢰등급 계약 — KBO=tier1(수치 정본), 나무위키=tier2(수치 확정 금지)
 *   4. 수치 충돌 게이트 — KBO 우선 / 대조 불가 시 보류
 *   5. chunk 메타 필수값 — 결측이면 ingest 거부(fail-closed)
 *   6. 정제·청킹 — 위키 마크업 제거, 원문 장문 보존 회피(길이 상한)
 *   7. 임베딩 차원 상수와 migration vector(768) 일치(drift 차단)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import playersRoster from "../../src/lib/constants/players-roster.json" with { type: "json" };
import { TEAMS } from "../../src/lib/constants/teams";
import {
  RAG_EMBEDDING_DIM,
  canGroundNumericClaim,
  gradeForSourceKind,
  missingChunkMetaKeys,
  resolveNumericConflict,
} from "../../src/lib/baseball-qa/rag/contracts";
import {
  KBO_RECORD_BOOK_SOURCES,
  buildInventorySeed,
  summarizeCoverage,
} from "../../src/lib/baseball-qa/rag/source-inventory";
import {
  MAX_CHUNK_CHARS,
  chunkText,
  prepareChunks,
  stripWikiMarkup,
} from "../../src/lib/baseball-qa/rag/ingest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

let pass = 0;
let fail = 0;

function check(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✓ ${name}`);
    pass++;
  } else {
    console.error(`✗ ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
    fail++;
  }
}

function ok(name: string, condition: boolean, detail = "") {
  check(name + (detail ? ` (${detail})` : ""), condition, true);
}

const roster = playersRoster as { name: string; kboId: string }[];
const seed = buildInventorySeed();
const coverage = summarizeCoverage(seed);

// --- 1. 전수 커버리지 -------------------------------------------------------
check("record_book 범주 전수 등재", coverage.byEntityType.record_book, KBO_RECORD_BOOK_SOURCES.length);
check("KBO 리그 페이지 1건", coverage.byEntityType.league, 1);
check("10개 구단 전량 등재", coverage.byEntityType.team, TEAMS.length);
check("로스터 878명 전수 등재", coverage.byEntityType.player, roster.length);
check(
  "인벤토리 총합 = 구성요소 합",
  coverage.total,
  KBO_RECORD_BOOK_SOURCES.length + 1 + TEAMS.length + roster.length,
);

// 선수 entityId는 kboId 전집합과 정확히 일치(1명도 누락/중복 없음)
const seededPlayerIds = seed.filter((r) => r.entityType === "player").map((r) => r.entityId).sort();
const rosterIds = roster.map((p) => p.kboId).sort();
check("선수 entityId 집합 = roster kboId 집합", seededPlayerIds, rosterIds);

// --- 2. 조용한 누락 금지 ----------------------------------------------------
const statusSum = Object.values(coverage.byStatus).reduce((a, b) => a + b, 0);
check("모든 행이 status 분류됨", statusSum, coverage.total);

// 동명이인 32그룹 72명(2026-07-31 실측)은 ambiguous로 분리, 임의 canonical 승격 금지
const nameCount = new Map<string, number>();
for (const p of roster) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1);
const expectedAmbiguous = roster.filter((p) => (nameCount.get(p.name) ?? 0) > 1).length;
check("동명이인 = ambiguous 분류", coverage.byStatus.ambiguous, expectedAmbiguous);
ok(
  "ambiguous 행은 canonicalUrl 없음(임의 선택 금지)",
  seed.filter((r) => r.status === "ambiguous").every((r) => r.canonicalUrl === null),
);

// 크롤 검증 전이므로 resolved는 0이어야 한다 — 확인 안 된 것을 확인됐다고 쓰지 않는다
check("시드 단계 resolved = 0 (미확인을 확인됨으로 승격 금지)", coverage.byStatus.resolved, 0);
ok(
  "pending 잔존 → 전수 완료 판정 불가",
  coverage.byStatus.pending > 0 && coverage.fullyClassified === false,
  `pending=${coverage.byStatus.pending}`,
);

// --- 3. 신뢰등급 계약 -------------------------------------------------------
check("KBO 공식 = tier1", gradeForSourceKind("kbo_official"), "tier1");
check("나무위키 = tier2", gradeForSourceKind("namuwiki"), "tier2");
ok("tier1만 정량 확정 자격", canGroundNumericClaim("tier1") && !canGroundNumericClaim("tier2"));
ok(
  "모든 시드 행의 grade가 sourceKind와 일치",
  seed.every((r) => r.sourceGrade === gradeForSourceKind(r.sourceKind)),
);
ok(
  "player/team/league 시드는 전부 tier2(나무위키)",
  seed
    .filter((r) => r.entityType !== "record_book")
    .every((r) => r.sourceGrade === "tier2"),
);

// --- 4. 수치 충돌 게이트 ----------------------------------------------------
check(
  "수치 충돌 → KBO 우선",
  resolveNumericConflict("38", "37"),
  { decision: "use_official", value: "38", reason: "conflict_official_wins" },
);
check(
  "KBO 값 없음 + 위키 값만 → 수치 보류",
  resolveNumericConflict(null, "37"),
  { decision: "hold_numeric", reason: "wiki_value_uncrosschecked" },
);
check(
  "양쪽 없음 → 보류",
  resolveNumericConflict(null, null),
  { decision: "hold_numeric", reason: "no_value_available" },
);
check(
  "일치 → KBO 채택",
  resolveNumericConflict("38", "38"),
  { decision: "use_official", value: "38", reason: "official_only_or_agree" },
);

// --- 5. chunk 메타 fail-closed ---------------------------------------------
check(
  "revision 결측 감지",
  missingChunkMetaKeys({
    entityType: "player",
    entityId: "64432",
    pageTitle: "김도영",
    canonicalUrl: "https://namu.wiki/w/x",
    sectionPath: "개요",
    crawledAt: "2026-07-31T00:00:00Z",
    contentHash: "h",
    sourceGrade: "tier2",
    asOf: "2026-07-31T00:00:00Z",
  }),
  ["revision"],
);

const baseDoc = {
  entityType: "player" as const,
  entityId: "64432",
  pageTitle: "김도영",
  canonicalUrl: "https://namu.wiki/w/%EA%B9%80%EB%8F%84%EC%98%81",
  revision: "r1234",
  sectionPath: "개요",
  sourceGrade: "tier2" as const,
  crawledAt: "2026-07-31T09:00:00Z",
  asOf: "2026-07-31T09:00:00Z",
};

const noRevision = prepareChunks({ ...baseDoc, revision: "", rawText: "본문 텍스트입니다." });
check("revision 없으면 ingest 거부", noRevision.ok, false);

// --- 6. 정제/청킹 ----------------------------------------------------------
const raw = [
  "== 개요 ==",
  "'''김도영'''은 [[KIA 타이거즈|기아]] 소속의 내야수이다.[* 각주 내용] 우투우타 3루수로 뛰며 리그를 대표하는 젊은 야수로 꼽힌다.",
  "",
  "<b>2024</b> 시즌 ~~부진~~ 활약했다. [br] 시즌 내내 주전 3루수로 출전하며 팀 타선의 중심 역할을 맡았다.",
].join("\n");
const cleaned = stripWikiMarkup(raw);
ok("각주 제거", !cleaned.includes("각주 내용"), cleaned.slice(0, 40));
ok("링크 표시텍스트만 남김", cleaned.includes("기아") && !cleaned.includes("[["));
ok("강조/취소선 마크업 제거", !cleaned.includes("'''") && !cleaned.includes("~~"));
ok("HTML 태그 제거", !cleaned.includes("<b>"));
ok("헤더 텍스트 보존", cleaned.includes("개요"));

const long = Array.from({ length: 40 }, (_, i) => `문단 ${i} ${"가".repeat(80)}`).join("\n\n");
const chunks = chunkText(long);
ok("장문은 다중 chunk로 분할(원문 통짜 보존 회피)", chunks.length > 1, `${chunks.length} chunks`);
ok("모든 chunk가 길이 상한 이하", chunks.every((c) => c.length <= MAX_CHUNK_CHARS));

// 문맥 없는 초단문은 retrieval 노이즈라 버리되, 조용히 빠뜨리지 않고 사유를 반환한다.
const tooShort = prepareChunks({ ...baseDoc, rawText: "짧음." });
check(
  "초단문은 사유와 함께 거부(조용한 누락 금지)",
  tooShort.ok === false ? tooShort.reason : "unexpected_ok",
  "no_chunk_above_min_length",
);

const prepared = prepareChunks({ ...baseDoc, rawText: raw });
ok("정상 문서 ingest 통과", prepared.ok === true);
if (prepared.ok) {
  ok(
    "모든 chunk 메타 완결",
    prepared.chunks.every((c) => missingChunkMetaKeys(c.meta).length === 0),
  );
  ok(
    "chunk마다 고유 contentHash 부착",
    prepared.chunks.every((c) => /^[0-9a-f]{64}$/.test(c.meta.contentHash)),
  );
  ok(
    "출처 링크 보존(재서술 + canonical link 계약)",
    prepared.chunks.every((c) => c.meta.canonicalUrl === baseDoc.canonicalUrl),
  );
}

// --- 7. 임베딩 차원 drift 차단 ---------------------------------------------
const migration = fs.readFileSync(
  path.join(ROOT, "supabase/migrations/20260731_genius_rag_source_inventory.sql"),
  "utf8",
);
const dimMatch = migration.match(/embedding\s+vector\((\d+)\)/);
check("migration vector 차원 == RAG_EMBEDDING_DIM", Number(dimMatch?.[1]), RAG_EMBEDDING_DIM);

// migration이 service_role 전용 RLS를 유지하는지(운영 DB 쓰기 경로 보호)
ok(
  "inventory/chunks RLS service_role 전용",
  migration.includes("REVOKE ALL ON public.genius_source_inventory FROM public, anon, authenticated") &&
    migration.includes("REVOKE ALL ON public.genius_rag_chunks FROM public, anon, authenticated"),
);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
