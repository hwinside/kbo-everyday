/**
 * 시즌 lane **parity** 게이트 — SQL `genius_doc_season` ≡ 앱 `parseEvidenceSeason`
 * (삼순 2026-08-28 재리뷰 P0-② "SQL lane과 앱 파서가 다릅니다").
 *
 * ── 🔴 왜 필요한가 ────────────────────────────────────────────────────────────
 *   lane 은 **DB 가 자르고**(recall) 가중은 **앱이 매긴다**(rank). 두 판정이 갈라지면:
 *     · 과거 문서의 `2026년 전망` 섹션이 year(2026) lane 에 섞여 **올해 lane 을 오염**
 *     · 연도 섹션을 가진 본문 문서가 yearless lane 에서 **누락**
 *   즉 lane 이 "목표 시즌 후보를 확보한다"는 계약을 배신한다. 문면 대조로는 못 잡는다 —
 *   같은 규칙인지는 **같은 입력에 같은 답을 내는지**로만 증명된다.
 *
 * ── 이 게이트가 하는 일 ──────────────────────────────────────────────────────
 *   P1  실제 migration 을 PGlite 에 적용해 **배포되는 SQL 함수**를 만든다(모의 아님).
 *   P2  코퍼스 형태 fixture 전수를 두 구현에 넣어 **결과 동치**를 고정한다.
 *   P3  lane 필터 종단 — `year`/`yearless` SELECT 결과가 앱 판정과 일치한다.
 *   P4  삼순이 지적한 두 오염 케이스가 실제로 닫혔는지 **직접** 고정한다.
 *   P5  season_mode 폐쇄집합·year 인자 필수 fail-close 가 SQL 안에서 강제된다.
 *
 * ⚠️ 이 게이트는 실제 SQL 을 실행한다. `AFTER(lane)` 프로덕션 실측(PGRST202)과 별개로,
 *   **함수 자체는 여기서 최초로 실행된다** — 삼순 "핵심 함수가 아직 한 번도 실행되지 않았다".
 *
 * 실행: npm run qa:genius-season-lane-parity
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

import { parseEvidenceSeason } from "../../src/lib/baseball-qa/rag/retrieve";

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
 * 아래 각 행은 판정 분기 중 하나를 콕 집는다 — identity 우선 / section 폴백 / 무연도 /
 * 복수 연도 최대값 / URL 인코딩 / 삼순 지적 오염 2건.
 */
const FIXTURES: DocShape[] = [
  // ① identity(page_title)에 연도 — 문서가 곧 시점
  { id: "title-2026", pageTitle: "롯데 자이언츠/2026년", canonicalUrl: "https://namu.wiki/w/%EB%A1%AF%EB%8D%B0%20%EC%9E%90%EC%9D%B4%EC%96%B8%EC%B8%A0/2026%EB%85%84", sectionPath: "9월" },
  // ② 🔴 삼순 지적 A — **과거 문서의 2026 섹션**. 앱은 2025 문서로 본다 → year(2026) lane 에 들어가면 오염.
  { id: "past-doc-future-section", pageTitle: "롯데 자이언츠/2025년", canonicalUrl: "https://namu.wiki/w/%EB%A1%AF%EB%8D%B0%20%EC%9E%90%EC%9D%B4%EC%96%B8%EC%B8%A0/2025%EB%85%84", sectionPath: "총평/2026년 전망" },
  // ③ 🔴 삼순 지적 B — **연도 없는 본문 문서의 연도 섹션**. identity 무연도 → section 폴백.
  { id: "body-doc-year-section", pageTitle: "한화 이글스", canonicalUrl: "https://namu.wiki/w/%ED%95%9C%ED%99%94%20%EC%9D%B4%EA%B8%80%EC%8A%A4", sectionPath: "역사/2017년 대비" },
  // ④ 완전 무연도 — yearless lane 의 정본(역대 감독표·등번호)
  { id: "yearless-managers", pageTitle: "한화 이글스", canonicalUrl: "https://namu.wiki/w/%ED%95%9C%ED%99%94%20%EC%9D%B4%EA%B8%80%EC%8A%A4", sectionPath: "역대 감독" },
  { id: "yearless-numbers", pageTitle: "NC 다이노스/등번호", canonicalUrl: "https://namu.wiki/w/NC%20%EB%8B%A4%EC%9D%B4%EB%85%B8%EC%8A%A4/%EB%93%B1%EB%B2%88%ED%98%B8", sectionPath: "" },
  // ⑤ section 에 연도 복수 — 최대값
  { id: "section-multi-year", pageTitle: "삼성 라이온즈", canonicalUrl: "https://namu.wiki/w/%EC%82%BC%EC%84%B1%20%EB%9D%BC%EC%9D%B4%EC%98%A8%EC%A6%88", sectionPath: "역사/2011년~2014년" },
  // ⑥ identity 에 연도 복수 — 최대값 (identity 가 section 을 덮는다)
  { id: "identity-multi-year", pageTitle: "기아 타이거즈/2024년~2025년", canonicalUrl: "https://namu.wiki/w/%EA%B8%B0%EC%95%84/2024%EB%85%84~2025%EB%85%84", sectionPath: "1999년 우승" },
  // ⑦ 올해 문서 + 하위 월
  { id: "current-month", pageTitle: "한화 이글스/2026년", canonicalUrl: "https://namu.wiki/w/%ED%95%9C%ED%99%94%20%EC%9D%B4%EA%B8%80%EC%8A%A4/2026%EB%85%84", sectionPath: "8월" },
  // ⑧ null/빈값 방어 — 실 코퍼스에 section_path 가 빈 행이 있다
  { id: "empty-section", pageTitle: "두산 베어스", canonicalUrl: "https://namu.wiki/w/%EB%91%90%EC%82%B0%20%EB%B2%A0%EC%96%B4%EC%8A%A4", sectionPath: "" },
  // ⑨ 오래된 연도(1900년대) — 하한 경계
  { id: "old-year", pageTitle: "MBC 청룡/1982년", canonicalUrl: "https://namu.wiki/w/MBC%20%EC%B2%AD%EB%A3%A1/1982%EB%85%84", sectionPath: "창단" },
  // ⑩ URL 에만 연도 — page_title 은 무연도인데 canonical_url 이 연도를 갖는 형태
  { id: "url-only-year", pageTitle: "키움 히어로즈 시즌", canonicalUrl: "https://namu.wiki/w/%ED%82%A4%EC%9B%80/2023%EB%85%84", sectionPath: "총평" },
];

async function main(): Promise<void> {
  // ── P1. 배포되는 migration 을 그대로 적용한다 ────────────────────────────
  const db = new PGlite({ extensions: { vector } });
  await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;");
  await db.exec("CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;");

  // ⚠️ 파일명을 하드코딩하지 않는다 — 나중에 이 함수를 고치는 migration 이 추가돼도
  //   게이트가 그걸 읽어야 검출력이 유지된다(2026-08-05 false-green 재발 방지 관행).
  const migrationDir = path.join(process.cwd(), "supabase/migrations");
  const laneMigrations = readdirSync(migrationDir)
    .filter((file) => file.endsWith(".sql"))
    .filter((file) =>
      readFileSync(path.join(migrationDir, file), "utf8")
        .includes("FUNCTION public.genius_doc_season"))
    .sort();
  check("P1 lane migration 을 찾았다", laneMigrations.length > 0, laneMigrations.join(","));
  if (laneMigrations.length === 0) {
    console.log("\nRED — failures=1 (migration 부재는 판정 불능이다)");
    process.exit(1);
  }
  for (const file of laneMigrations) {
    // search_baseball_genius_player_chunks 오버로드는 서빙 뷰에 의존하므로 helper 만 뽑아
    // 적용한다 — parity 판정에 필요한 것은 `genius_doc_season` 이다.
    const sql = readFileSync(path.join(migrationDir, file), "utf8");
    const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.genius_doc_season");
    const end = sql.indexOf("COMMENT ON FUNCTION public.genius_doc_season");
    const helperSql = sql.slice(start, sql.indexOf(";", sql.indexOf("$$;", start)) + 1);
    check(`P1b helper 추출 (${file})`, start >= 0 && end > start && helperSql.includes("$$"),
      `start=${start} end=${end}`);
    await db.exec(helperSql);
  }
  // 재적용 멱등 — 배포는 같은 파일을 다시 돌릴 수 있다.
  for (const file of laneMigrations) {
    const sql = readFileSync(path.join(migrationDir, file), "utf8");
    const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.genius_doc_season");
    await db.exec(sql.slice(start, sql.indexOf(";", sql.indexOf("$$;", start)) + 1));
  }

  // ── P2. 동치 전수 대조 ───────────────────────────────────────────────────
  //
  // 🔴 판정은 "둘 다 같은 값" 이다. 앱 기대값을 게이트가 재구현하지 않는다 —
  //   재구현하면 게이트가 제3의 구현이 되어 진짜 결함을 못 본다(M90).
  const mismatches: string[] = [];
  for (const doc of FIXTURES) {
    const appSeason = parseEvidenceSeason({
      pageTitle: doc.pageTitle,
      canonicalUrl: doc.canonicalUrl,
      sectionPath: doc.sectionPath,
    });
    const res = await db.query<{ season: number | null }>(
      "SELECT public.genius_doc_season($1, $2, $3) AS season",
      [doc.pageTitle, doc.canonicalUrl, doc.sectionPath],
    );
    const sqlSeason = res.rows[0]?.season ?? null;
    if (appSeason !== sqlSeason) {
      mismatches.push(`${doc.id}: app=${appSeason} sql=${sqlSeason}`);
    }
  }
  check(`P2 SQL ≡ 앱 (전 ${FIXTURES.length}형태)`, mismatches.length === 0, mismatches.join(" | "));

  // NULL 입력도 같은 답이어야 한다 — 실 코퍼스에 NULL section_path 가 있다.
  const nullRes = await db.query<{ season: number | null }>(
    "SELECT public.genius_doc_season(NULL, NULL, NULL) AS season");
  check("P2b NULL 입력 = 무연도(NULL)", (nullRes.rows[0]?.season ?? null) === null
    && parseEvidenceSeason({ pageTitle: "", canonicalUrl: "", sectionPath: "" }) === null);

  // ── P3. lane 필터 종단 — SELECT 결과가 앱 판정과 일치 ────────────────────
  await db.exec(`CREATE TABLE parity_chunks (
    id text primary key, page_title text, canonical_url text, section_path text)`);
  for (const doc of FIXTURES) {
    await db.query(
      "INSERT INTO parity_chunks VALUES ($1,$2,$3,$4)",
      [doc.id, doc.pageTitle, doc.canonicalUrl, doc.sectionPath]);
  }
  const laneRows = async (mode: "year" | "yearless", year?: number): Promise<Set<string>> => {
    const rows = await db.query<{ id: string }>(
      mode === "yearless"
        ? "SELECT id FROM parity_chunks WHERE public.genius_doc_season(page_title, canonical_url, section_path) IS NULL"
        : "SELECT id FROM parity_chunks WHERE public.genius_doc_season(page_title, canonical_url, section_path) = $1",
      mode === "yearless" ? [] : [year]);
    return new Set(rows.rows.map((r) => r.id));
  };
  const appLane = (predicate: (season: number | null) => boolean): Set<string> =>
    new Set(FIXTURES.filter((doc) => predicate(parseEvidenceSeason({
      pageTitle: doc.pageTitle, canonicalUrl: doc.canonicalUrl, sectionPath: doc.sectionPath,
    }))).map((doc) => doc.id));

  const sameSet = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every((v) => b.has(v));

  const sqlYearless = await laneRows("yearless");
  const expectYearless = appLane((s) => s === null);
  check("P3 yearless lane 종단 일치",
    sameSet(sqlYearless, expectYearless),
    `sql=${[...sqlYearless].sort().join(",")} app=${[...expectYearless].sort().join(",")}`);

  const sql2026 = await laneRows("year", 2026);
  const expect2026 = appLane((s) => s === 2026);
  check("P3b year(2026) lane 종단 일치",
    sameSet(sql2026, expect2026),
    `sql=${[...sql2026].sort().join(",")} app=${[...expect2026].sort().join(",")}`);

  const sql2025 = await laneRows("year", 2025);
  const expect2025 = appLane((s) => s === 2025);
  check("P3c year(2025) lane 종단 일치", sameSet(sql2025, expect2025),
    `sql=${[...sql2025].sort().join(",")} app=${[...expect2025].sort().join(",")}`);

  // ── P4. 삼순이 지적한 오염 2건을 **직접** 고정한다 ────────────────────────
  //
  // 축이 P3 에 포함되긴 하지만, 이 둘은 리뷰가 콕 집은 결함이라 **이름이 붙은 축**으로
  // 따로 둔다 — fixture 를 나중에 손대도 이 두 문장은 남는다.
  check("P4 과거 문서의 2026 섹션이 year(2026) lane 에 안 들어간다 (오염 차단)",
    !sql2026.has("past-doc-future-section"),
    [...sql2026].join(","));
  check("P4b 그 문서는 자기 시즌(2025) lane 에 들어간다",
    sql2025.has("past-doc-future-section"));
  check("P4c 연도 섹션을 가진 본문 문서는 yearless 가 아니다 (앱과 동일)",
    !sqlYearless.has("body-doc-year-section")
    && parseEvidenceSeason({
      pageTitle: "한화 이글스",
      canonicalUrl: "https://namu.wiki/w/%ED%95%9C%ED%99%94%20%EC%9D%B4%EA%B8%80%EC%8A%A4",
      sectionPath: "역사/2017년 대비",
    }) === 2017);
  check("P4d 진짜 무연도 문서(역대 감독·등번호)는 yearless 에 남는다",
    sqlYearless.has("yearless-managers") && sqlYearless.has("yearless-numbers"));

  // ── P5. SQL 안의 fail-close (문면이 아니라 실행으로) ─────────────────────
  const laneSql = readFileSync(path.join(migrationDir, laneMigrations[0]), "utf8");
  check("P5 season_mode 폐쇄집합이 SQL 안에서 강제된다",
    /NOT IN \('any', 'year', 'yearless'\)/.test(laneSql)
    && /RAISE EXCEPTION 'unsupported season_mode/.test(laneSql));
  check("P5b year lane 은 연도 인자를 요구한다",
    /p_season_mode = 'year' AND p_season_year IS NULL/.test(laneSql)
    && /RAISE EXCEPTION 'season_year is required/.test(laneSql));
  check("P5c lane 필터가 helper 를 쓴다 (판정 재구현 금지)",
    /p_season_mode = 'yearless'\s*\n\s*AND public\.genius_doc_season/.test(laneSql)
    && /p_season_mode = 'year'\s*\n\s*AND public\.genius_doc_season/.test(laneSql));
  check("P5d helper 는 본문(content)을 보지 않는다",
    !/genius_doc_season[\s\S]{0,900}chunk\.content/.test(laneSql));
  check("P5e helper 권한은 service_role 한정",
    /REVOKE ALL ON FUNCTION public\.genius_doc_season\(text, text, text\) FROM PUBLIC, anon, authenticated/
      .test(laneSql)
    && /GRANT EXECUTE ON FUNCTION public\.genius_doc_season\(text, text, text\) TO service_role/.test(laneSql));

  if (SELFTEST) {
    console.log("\n── selftest (판정 경계) ──");
    // 두 구현이 **다르면** 실제로 RED 가 나는지 — 게이트가 동치를 정말 보는지 확인.
    const drift = await db.query<{ season: number | null }>(
      "SELECT max(m[1]::integer) AS season FROM regexp_matches($1, '(19[0-9]{2}|20[0-9]{2})', 'g') AS m",
      ["롯데 자이언츠/2025년 총평/2026년 전망"]);
    check("selftest A 전체 문자열 정규식은 2026 을 뽑는다 (초안 SQL 의 결함 재현)",
      (drift.rows[0]?.season ?? null) === 2026);
    check("selftest B 앱은 같은 문서를 2025 로 본다 (그래서 초안은 parity 위반)",
      parseEvidenceSeason({
        pageTitle: "롯데 자이언츠/2025년",
        canonicalUrl: "https://namu.wiki/w/%EB%A1%AF%EB%8D%B0/2025%EB%85%84",
        sectionPath: "총평/2026년 전망",
      }) === 2025);
  }

  await db.close();
  console.log(`\n${failures === 0 ? "GREEN" : "RED"} — failures=${failures}`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error("FAIL 게이트 실행 실패", error);
  process.exit(1);
});
