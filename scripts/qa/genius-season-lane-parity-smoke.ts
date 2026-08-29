/**
 * 시즌 lane **parity + 실 RPC 실행** 게이트
 * (삼순 2026-08-28 3차 P0-② "SQL lane과 앱 파서가 다릅니다" · 4차 P0-③ "실행 증거 미충족").
 *
 * ── 🔴 왜 필요한가 ────────────────────────────────────────────────────────────
 *   lane 은 **DB 가 자르고**(recall) 가중은 **앱이 매긴다**(rank). 두 판정이 갈라지면:
 *     · 과거 문서의 `2026년 전망` 섹션이 year(2026) lane 에 섞여 **올해 lane 을 오염**
 *     · 연도 섹션을 가진 본문 문서가 yearless lane 에서 **누락**
 *   문면 대조로는 못 잡는다 — 같은 규칙인지는 **같은 입력에 같은 답을 내는지**로만 증명된다.
 *
 * ── 🔴 3차 게이트의 결함(삼순 4차 지적) ──────────────────────────────────────
 *   초판은 `genius_doc_season` helper 만 잘라 적용하고 임시 `parity_chunks` 를 만들어
 *   **lane 을 게이트가 재현**했다. 그러면 helper 는 검증되지만 **배포되는 7인자 RPC 는
 *   한 번도 안 돈다** — 그 RPC 의 WHERE 절이 helper 를 안 쓰도록 변조돼도 GREEN 이다.
 *   → 이번엔 RAG 계약 migration 을 **내용 기준 사전순 전량 적용**하고, 실제 서빙 뷰에
 *     chunk 를 적재한 뒤 **`search_baseball_genius_player_chunks` 7인자 오버로드를 실행**한다.
 *
 * ── 검증 축 ──────────────────────────────────────────────────────────────────
 *   P1  배포되는 migration 전량 적용(내용 기준·사전순) + 멱등 재적용
 *   P2  `genius_doc_season` ≡ 앱 `parseEvidenceSeason` 전수 동치
 *   P3  🔴 **실제 7인자 RPC 실행** — year/yearless/any lane 결과가 앱 판정과 일치
 *   P4  삼순이 지적한 오염 2건을 이름 붙은 축으로 고정(RPC 결과 기준)
 *   P5  RPC fail-close — season_mode 폐쇄집합·year 인자 필수·영벡터(실행으로 판정)
 *   P6  5인자 오버로드 보존 — lane 없는 종전 호출이 그대로 돈다(선수·뉴스 경로 무영향)
 *
 * 실행: npm run qa:genius-season-lane-parity
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

import { parseEvidenceSeason } from "../../src/lib/baseball-qa/rag/retrieve";
import { RAG_EMBEDDING_DIM } from "../../src/lib/baseball-qa/rag/contracts";

const SELFTEST = process.argv.includes("--selftest");
let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** 나무위키 구단 코퍼스에서 실제로 나타나는 (page_title, canonical_url, section_path) 형태. */
interface DocShape {
  id: string;
  pageTitle: string;
  canonicalUrl: string;
  sectionPath: string;
}

/**
 * fixture 는 **경계를 실제로 걸쳐야** 한다(M90: 무대가 없으면 mutation 은 무증상).
 * 각 행이 판정 분기 하나를 콕 집는다 — identity 우선 / section 폴백 / 무연도 /
 * 복수 연도 최대값 / URL 연도 / 삼순 지적 오염 2건.
 */
const FIXTURES: DocShape[] = [
  // ① identity(page_title)에 연도 — 문서가 곧 시점
  { id: "title-2026", pageTitle: "롯데 자이언츠/2026년", canonicalUrl: "https://namu.wiki/w/%EB%A1%AF%EB%8D%B0%20%EC%9E%90%EC%9D%B4%EC%96%B8%EC%B8%A0/2026%EB%85%84", sectionPath: "9월" },
  // ② 🔴 삼순 지적 A — **과거 문서의 2026 섹션**. 앱은 2025 문서로 본다 → year(2026) lane 오염.
  { id: "past-doc-future-section", pageTitle: "롯데 자이언츠/2025년", canonicalUrl: "https://namu.wiki/w/%EB%A1%AF%EB%8D%B0%20%EC%9E%90%EC%9D%B4%EC%96%B8%EC%B8%A0/2025%EB%85%84", sectionPath: "총평/2026년 전망" },
  // ③ 🔴 삼순 지적 B — **연도 없는 본문 문서의 연도 섹션**. identity 무연도 → section 폴백.
  { id: "body-doc-year-section", pageTitle: "한화 이글스", canonicalUrl: "https://namu.wiki/w/%ED%95%9C%ED%99%94%20%EC%9D%B4%EA%B8%80%EC%8A%A4", sectionPath: "역사/2017년 대비" },
  // ④ 완전 무연도 — yearless lane 의 정본(역대 감독표·등번호)
  { id: "yearless-managers", pageTitle: "한화 이글스", canonicalUrl: "https://namu.wiki/w/%ED%95%9C%ED%99%94%20%EC%9D%B4%EA%B8%80%EC%8A%A4", sectionPath: "역대 감독" },
  { id: "yearless-numbers", pageTitle: "NC 다이노스/등번호", canonicalUrl: "https://namu.wiki/w/NC%20%EB%8B%A4%EC%9D%B4%EB%85%B8%EC%8A%A4/%EB%93%B1%EB%B2%88%ED%98%B8", sectionPath: "선수단" },
  // ⑤ section 에 연도 복수 — 최대값
  { id: "section-multi-year", pageTitle: "삼성 라이온즈", canonicalUrl: "https://namu.wiki/w/%EC%82%BC%EC%84%B1%20%EB%9D%BC%EC%9D%B4%EC%98%A8%EC%A6%88", sectionPath: "역사/2011년~2014년" },
  // ⑥ identity 에 연도 복수 — 최대값 (identity 가 section 을 덮는다)
  { id: "identity-multi-year", pageTitle: "기아 타이거즈/2024년~2025년", canonicalUrl: "https://namu.wiki/w/%EA%B8%B0%EC%95%84/2024%EB%85%84~2025%EB%85%84", sectionPath: "1999년 우승" },
  // ⑦ 올해 문서 + 하위 월
  { id: "current-month", pageTitle: "한화 이글스/2026년", canonicalUrl: "https://namu.wiki/w/%ED%95%9C%ED%99%94%20%EC%9D%B4%EA%B8%80%EC%8A%A4/2026%EB%85%84", sectionPath: "8월" },
  // ⑧ 오래된 연도(1900년대) — 하한 경계
  { id: "old-year", pageTitle: "MBC 청룡/1982년", canonicalUrl: "https://namu.wiki/w/MBC%20%EC%B2%AD%EB%A3%A1/1982%EB%85%84", sectionPath: "창단" },
  // ⑨ URL 에만 연도 — page_title 은 무연도인데 canonical_url 이 연도를 갖는 형태
  { id: "url-only-year", pageTitle: "키움 히어로즈 시즌", canonicalUrl: "https://namu.wiki/w/%ED%82%A4%EC%9B%80/2023%EB%85%84", sectionPath: "총평" },
];

/** chunk 본문 길이 제약(40~900자)을 만족하는 더미 본문. */
const filler = (id: string) =>
  `${id} 관련 서술입니다. `.repeat(4) + "이 문단은 게이트 fixture 로 삽입된 구단 문서 본문이며 시즌 lane 판정을 위한 경로 메타만 의미가 있습니다.";

const EMBEDDING = `[${Array.from({ length: RAG_EMBEDDING_DIM }, () => 0.01).join(",")}]`;
const QUERY_VECTOR = EMBEDDING;

const ENTITY_ID = "1001";
const CLAIM_TOKEN = "11111111-1111-1111-1111-111111111111";

/**
 * 🔴 RPC 축 fixture 는 **프로덕션 적재 형태**여야 한다.
 *
 *   `genius_rag_sources` 에 `UNIQUE (source_kind, entity_type, entity_id)` 가 있고
 *   owner trigger 가 chunk 의 `page_title`·`canonical_url` 을 source 행과 일치시키므로,
 *   **한 구단 = source 1행 = page_title 1개**다. 그래서 나무위키 구단 문서의 연도는
 *   `section_path` 에 실린다(실측: `롯데 자이언츠` + `/2025년/9월`).
 *
 *   ⚠️ 이걸 무시하고 page_title 마다 source 를 만들면 UNIQUE 에 걸리고, 우회하려면
 *   스키마를 건드려야 한다 — 그러면 "배포되는 스키마를 태운다"는 성질이 사라진다.
 *   identity(page_title/URL) 분기는 **P2 helper parity** 가 전 형태로 덮는다.
 */
const TEAM_PAGE_TITLE = "롯데 자이언츠";
const TEAM_CANONICAL_URL = "https://namu.wiki/w/%EB%A1%AF%EB%8D%B0%20%EC%9E%90%EC%9D%B4%EC%96%B8%EC%B8%A0";

/** RPC lane 축 — section_path 만 다르다(프로덕션 그대로). */
const RPC_SECTIONS: ReadonlyArray<{ id: string; sectionPath: string }> = [
  { id: "cur-9", sectionPath: "2026년/9월" },
  { id: "cur-8", sectionPath: "2026년/8월" },
  { id: "past-2025", sectionPath: "2025년/9월" },
  { id: "past-2025-total", sectionPath: "2025년/총평" },
  { id: "past-2019", sectionPath: "2019년" },
  { id: "range-2011-2014", sectionPath: "역사/2011년~2014년" },
  { id: "yearless-managers", sectionPath: "역대 감독" },
  { id: "yearless-numbers", sectionPath: "등번호/선수단" },
  { id: "yearless-song", sectionPath: "응원가" },
  // 🔴 오염 축: 과거 시즌 섹션 안에 다음 해 전망이 들어 있다.
  //   app·SQL 모두 "경로 최대 연도"로 판정하므로 **둘이 같아야** 한다 —
  //   초안 SQL 처럼 "연도가 등장하나"만 보면 2025 lane 에도 걸려 lane 이 뭉개진다.
  { id: "past-doc-future-section", sectionPath: "2025년/총평/2026년 전망" },
];

async function main(): Promise<void> {
  // ── P1. 배포되는 migration 을 **전량** 적용한다 ──────────────────────────
  const db = new PGlite({ extensions: { vector } });
  await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;");

  // ⚠️ 파일**명**으로 고르지 않는다 (2026-08-05 자체 적발 false-green 관행).
  //   RAG 계약 테이블/함수를 건드리는 파일을 **내용으로** 골라 사전순(=배포 적용순) 적용한다.
  const migrationDir = path.join(process.cwd(), "supabase/migrations");
  const RAG_CONTRACT_SQL =
    /genius_rag_sources|genius_rag_chunks|genius_rag_serving_chunks|claim_baseball_genius_rag|search_baseball_genius_player_chunks|genius_doc_season/;
  const ragMigrations = readdirSync(migrationDir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => RAG_CONTRACT_SQL.test(readFileSync(path.join(migrationDir, f), "utf8")))
    .sort();
  check("P1 RAG 계약 migration 을 찾았다", ragMigrations.length >= 4, `${ragMigrations.length}개`);
  check("P1b 이번 lane migration 이 적용 대상에 포함",
    ragMigrations.some((f) => readFileSync(path.join(migrationDir, f), "utf8")
      .includes("FUNCTION public.genius_doc_season")),
    ragMigrations.join(","));
  if (ragMigrations.length < 4) {
    console.log("\nRED — failures=1 (migration 부재는 판정 불능이다)");
    process.exit(1);
  }
  for (const f of ragMigrations) {
    await db.exec(readFileSync(path.join(migrationDir, f), "utf8"));
  }
  // 멱등 재적용 — 기반본(20260731)은 CREATE TRIGGER 가드가 없어 원래 재적용 불가(선재 성질).
  for (const f of ragMigrations.filter((x) => !/^20260731/.test(x))) {
    await db.exec(readFileSync(path.join(migrationDir, f), "utf8"));
  }
  check("P1c 멱등 재적용 통과", true);

  // ── P2. helper 동치 전수 대조 ────────────────────────────────────────────
  //
  // 🔴 앱 기대값을 게이트가 재구현하지 않는다 — 재구현하면 게이트가 제3의 구현이 되어
  //   진짜 결함을 못 본다(M90).
  const appSeasonOf = (doc: DocShape) => parseEvidenceSeason({
    pageTitle: doc.pageTitle, canonicalUrl: doc.canonicalUrl, sectionPath: doc.sectionPath,
  });
  const mismatches: string[] = [];
  for (const doc of FIXTURES) {
    const res = await db.query<{ season: number | null }>(
      "SELECT public.genius_doc_season($1, $2, $3) AS season",
      [doc.pageTitle, doc.canonicalUrl, doc.sectionPath],
    );
    const sqlSeason = res.rows[0]?.season ?? null;
    if (appSeasonOf(doc) !== sqlSeason) {
      mismatches.push(`${doc.id}: app=${appSeasonOf(doc)} sql=${sqlSeason}`);
    }
  }
  check(`P2 SQL ≡ 앱 (전 ${FIXTURES.length}형태)`, mismatches.length === 0, mismatches.join(" | "));
  const nullRes = await db.query<{ season: number | null }>(
    "SELECT public.genius_doc_season(NULL, NULL, NULL) AS season");
  check("P2b NULL 입력 = 무연도(NULL)", (nullRes.rows[0]?.season ?? null) === null
    && parseEvidenceSeason({ pageTitle: "", canonicalUrl: "", sectionPath: "" }) === null);

  // ── 실 서빙 뷰에 chunk 적재 ──────────────────────────────────────────────
  //
  // 🔴 여기가 3차 게이트와의 결정적 차이다. 임시 테이블이 아니라 **서빙 뷰가 노출하는
  //   진짜 경로**에 넣고, 배포되는 RPC 로 읽는다.
  // ⚠️ `ready` 는 **matching provenance chunk 가 이미 있어야** 통과한다(trigger 계약).
  //   그래서 source 를 먼저 pending 으로 만들고, chunk 를 넣은 뒤 ready 로 올린다 —
  //   운영 수집기가 실제로 하는 순서와 같다. 순서를 우회하려고 trigger 를 끄면
  //   "배포되는 스키마를 태운다"는 성질이 사라진다.
  // 🔴 운영과 같은 단위로 넣는다: **한 구단 = source 1행**(UNIQUE(source_kind,entity_type,entity_id)).
  //   owner trigger 가 chunk 의 page_title·canonical_url 을 source 행과 일치시키므로
  //   연도는 section_path 에 실린다 — 프로덕션 적재 형태 그대로다.
  await db.query(
    `INSERT INTO public.genius_rag_sources
      (source_key, source_kind, entity_type, entity_id, page_title, candidate_urls, canonical_url,
       revision, content_hash, crawled_at, ingested_at,
       resolution_status, source_grade, identity_fingerprint, ingestion_status, active_claim_generation)
     VALUES ('namu:team:lane','namu_document','team',$1,$2,ARRAY[$3],$3,
       'rev1','doc-hash','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',
       'resolved','tier2','fp-lane','not_started',0)`,
    [ENTITY_ID, TEAM_PAGE_TITLE, TEAM_CANONICAL_URL],
  );
  // chunk INSERT 는 owner trigger 가 **ingesting + 유효 lease + 일치하는 claim_token** 을
  // 요구한다(운영 수집기가 claim RPC 로 얻는 상태). 그 상태를 그대로 만든다 —
  // trigger 를 끄거나 우회하면 "배포되는 스키마를 태운다"는 성질이 사라진다.
  await db.query(
    `UPDATE public.genius_rag_sources
        SET ingestion_status = 'ingesting', claim_token = $1::uuid, claim_generation = 1,
            lease_until = clock_timestamp() + interval '10 minutes'
      WHERE source_key = 'namu:team:lane'`,
    [CLAIM_TOKEN],
  );
  for (const [index, sec] of RPC_SECTIONS.entries()) {
    await db.query(
      `INSERT INTO public.genius_rag_chunks
        (source_key, source_kind, entity_type, entity_id, page_title, canonical_url, revision,
         section_path, chunk_index, content, document_content_hash, content_hash, source_grade,
         crawled_at, as_of, claim_token, claim_generation, embedding)
       VALUES ('namu:team:lane','namu_document','team',$1,$2,$3,'rev1',$4,$5,$6,'doc-hash',$7,'tier2',
         '2026-08-01T00:00:00Z','2026-08-01',$8::uuid,1,$9::extensions.vector)`,
      [ENTITY_ID, TEAM_PAGE_TITLE, TEAM_CANONICAL_URL, sec.sectionPath, index,
        filler(sec.id), `hash-${sec.id}`, CLAIM_TOKEN, EMBEDDING],
    );
  }
  // chunk 가 들어왔으니 active generation 을 올려 ready 로 전환한다
  // (trigger `validate_baseball_genius_rag_ready` + ready_provenance CHECK 둘 다 충족).
  await db.query(
    `UPDATE public.genius_rag_sources
        SET active_claim_generation = 1, ingestion_status = 'ready',
            claim_token = NULL, lease_until = NULL
      WHERE source_key = 'namu:team:lane'`,
  );

  const served = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM public.genius_rag_serving_chunks WHERE entity_id = $1", [ENTITY_ID]);
  check("P2c 서빙 뷰에 fixture 가 노출된다", served.rows[0]?.n === RPC_SECTIONS.length,
    `${served.rows[0]?.n}/${RPC_SECTIONS.length}`);
  assert.equal(served.rows[0]?.n, RPC_SECTIONS.length, "서빙 뷰 적재 실패 — 이후 RPC 판정이 무의미해진다");

  // ── P3. 🔴 **배포되는 7인자 RPC 를 실제로 실행**한다 ─────────────────────
  //
  //   section_path 로 행을 식별한다 — content 는 filler 라 구분이 안 되고,
  //   안정 식별자로 비교해야 다른 행을 태우고도 통과하는 사고가 안 난다(M90).
  const rpcLane = async (mode: "any" | "year" | "yearless", year: number | null): Promise<Set<string>> => {
    const rows = await db.query<{ section_path: string }>(
      `SELECT * FROM public.search_baseball_genius_player_chunks(
         'team', $1, 'namu_document', $2, 50, $3, $4)`,
      [ENTITY_ID, QUERY_VECTOR, mode, year],
    );
    return new Set(rows.rows.map((r) => {
      const found = RPC_SECTIONS.find((d) => d.sectionPath === r.section_path);
      return found?.id ?? `UNKNOWN(${r.section_path})`;
    }));
  };
  /** 앱 판정 — 게이트가 규칙을 재구현하지 않고 **배포되는 함수**를 그대로 부른다. */
  const appSeasonOfSection = (sectionPath: string) => parseEvidenceSeason({
    pageTitle: TEAM_PAGE_TITLE, canonicalUrl: TEAM_CANONICAL_URL, sectionPath,
  });
  const appLane = (predicate: (season: number | null) => boolean): Set<string> =>
    new Set(RPC_SECTIONS.filter((d) => predicate(appSeasonOfSection(d.sectionPath))).map((d) => d.id));
  const sameSet = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every((v) => b.has(v));
  const show = (s2: Set<string>) => [...s2].sort().join(",");

  const rpcAny = await rpcLane("any", null);
  check("P3 any lane = 전체 (RPC 실행)",
    sameSet(rpcAny, new Set(RPC_SECTIONS.map((d) => d.id))), show(rpcAny));

  const rpcYearless = await rpcLane("yearless", null);
  check("P3b yearless lane ≡ 앱 판정 (RPC 실행)",
    sameSet(rpcYearless, appLane((s2) => s2 === null)),
    `rpc=${show(rpcYearless)} app=${show(appLane((s2) => s2 === null))}`);

  const rpc2026 = await rpcLane("year", 2026);
  check("P3c year(2026) lane ≡ 앱 판정 (RPC 실행)",
    sameSet(rpc2026, appLane((s2) => s2 === 2026)),
    `rpc=${show(rpc2026)} app=${show(appLane((s2) => s2 === 2026))}`);

  const rpc2025 = await rpcLane("year", 2025);
  check("P3d year(2025) lane ≡ 앱 판정 (RPC 실행)",
    sameSet(rpc2025, appLane((s2) => s2 === 2025)),
    `rpc=${show(rpc2025)} app=${show(appLane((s2) => s2 === 2025))}`);

  const rpc2014 = await rpcLane("year", 2014);
  check("P3e year(2014) lane ≡ 앱 판정 — 연도 범위 섹션 (RPC 실행)",
    sameSet(rpc2014, appLane((s2) => s2 === 2014)),
    `rpc=${show(rpc2014)} app=${show(appLane((s2) => s2 === 2014))}`);

  // ── P4. 삼순이 지적한 오염 — RPC 결과로 고정 ─────────────────────────────
  //
  // 🔴 `2025년/총평/2026년 전망` 은 **경로 최대 연도 = 2026** 이므로 2026 lane 에 든다.
  //   핵심은 "app 과 SQL 이 같은 답을 낸다" 이지 특정 lane 에 넣고 빼는 것이 아니다 —
  //   초안 SQL 은 이 행을 **2025 lane 에도** 넣어서(연도 등장 여부만 봄) lane 을 뭉갰다.
  check("P4 오염 행이 두 lane 에 동시에 들지 않는다 (초안 SQL 의 결함)",
    !(rpc2025.has("past-doc-future-section") && rpc2026.has("past-doc-future-section")),
    `2025=${show(rpc2025)} / 2026=${show(rpc2026)}`);
  check("P4b 그 행의 lane 귀속이 앱 판정과 동일",
    rpc2026.has("past-doc-future-section") === (appSeasonOfSection("2025년/총평/2026년 전망") === 2026)
    && rpc2025.has("past-doc-future-section") === (appSeasonOfSection("2025년/총평/2026년 전망") === 2025));
  check("P4c 순수 과거 섹션은 자기 시즌 lane 에만",
    rpc2025.has("past-2025") && !rpc2026.has("past-2025"), `${show(rpc2025)} / ${show(rpc2026)}`);
  check("P4d 진짜 무연도 문서(역대 감독·등번호·응원가)는 yearless 에 남는다",
    rpcYearless.has("yearless-managers") && rpcYearless.has("yearless-numbers")
    && rpcYearless.has("yearless-song"), show(rpcYearless));
  check("P4e 목표 시즌 lane 이 실제로 좁힌다 (any 보다 작다)",
    rpc2026.size > 0 && rpc2026.size < rpcAny.size, `${rpc2026.size} < ${rpcAny.size}`);

  // ── P5. RPC fail-close — 문면이 아니라 **실행**으로 판정 ─────────────────
  const throws = async (fn: () => Promise<unknown>, re: RegExp): Promise<boolean> => {
    try { await fn(); return false; } catch (error) { return re.test(String(error)); }
  };
  check("P5 season_mode 폐쇄집합 — 오타는 조용한 any 가 아니라 예외",
    await throws(() => rpcLane("bogus" as "any", null), /unsupported season_mode/));
  check("P5b year lane 은 연도 인자를 요구한다",
    await throws(() => rpcLane("year", null), /season_year is required/));
  check("P5c 영벡터 fail-close 는 그대로",
    await throws(async () => db.query(
      `SELECT * FROM public.search_baseball_genius_player_chunks(
         'team', $1, 'namu_document', $2, 50, 'any', NULL)`,
      [ENTITY_ID, `[${Array.from({ length: RAG_EMBEDDING_DIM }, () => 0).join(",")}]`],
    ), /non-zero/));
  check("P5d entity_type 폐쇄집합 유지",
    await throws(async () => db.query(
      `SELECT * FROM public.search_baseball_genius_player_chunks(
         'league', $1, 'namu_document', $2, 50, 'any', NULL)`,
      [ENTITY_ID, QUERY_VECTOR],
    ), /unsupported entity_type/));

  // ── P6. 5인자 오버로드 보존 — 종전 경로(선수·뉴스)가 그대로 돈다 ─────────
  //
  // 🔴 이게 깨지면 lane 을 안 쓰는 모든 호출이 죽는다. 그리고 이 오버로드가 살아 있어야
  //   PGRST202 fallback(migration-before-app)이 의미를 갖는다.
  const legacy = await db.query<{ section_path: string }>(
    `SELECT * FROM public.search_baseball_genius_player_chunks(
       'team', $1, 'namu_document', $2, 50)`,
    [ENTITY_ID, QUERY_VECTOR],
  );
  check("P6 5인자 오버로드가 살아 있다 (lane 없는 종전 호출)",
    legacy.rows.length === RPC_SECTIONS.length, `${legacy.rows.length}/${RPC_SECTIONS.length}`);

  if (SELFTEST) {
    console.log("\n── selftest (판정 경계) ──");
    // 3차 게이트가 놓쳤던 것: helper 가 맞아도 RPC 가 helper 를 안 쓰면 lane 이 깨진다.
    // 여기서 그 구조를 직접 보인다 — "전체 문자열 정규식" 방식은 다른 답을 낸다.
    const drift = await db.query<{ season: number | null }>(
      "SELECT max(m[1]::integer) AS season FROM regexp_matches($1, '(19[0-9]{2}|20[0-9]{2})', 'g') AS m",
      ["롯데 자이언츠/2025년 총평/2026년 전망"]);
    check("selftest A 전체 문자열 정규식은 2026 을 뽑는다 (초안 SQL 의 결함 재현)",
      (drift.rows[0]?.season ?? null) === 2026);
    check("selftest B 앱은 같은 문서를 2025 로 본다 (그래서 초안은 parity 위반)",
      appSeasonOf(FIXTURES[1]) === 2025);
    check("selftest C 그리고 RPC 는 앱 편이다 (helper 결속 확인)",
      !rpc2026.has("past-doc-future-section") && rpc2025.has("past-doc-future-section"));
  }

  await db.close();
  console.log(`\n${failures === 0 ? "GREEN" : "RED"} — failures=${failures}`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error("FAIL 게이트 실행 실패", error);
  process.exit(1);
});
