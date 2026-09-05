/**
 * 커뮤니티 검색 v1 회귀 (#cs 건의함 feedback:8f16ef65).
 *
 * 고정하는 계약:
 *  A. 순수 함수 — `normalizeSearchQuery`(trim·최소 길이·이스케이프 안 함) / `feedKeyFor`(검색어별 키 분리, 무검색 "all" 호환).
 *  B. DB 함수 `search_posts` 의 의미 — **실제 Postgres(PGlite + pg_trgm)** 에서 migration SQL 을 그대로 적용해 검증.
 *     ① 제목/본문 각각 매치(대소문자 무시) ② is_hidden 제외 ③ 허용 board_type 만 ④ id desc 키셋 2페이지 연속·중복 0
 *     ⑤ `%`·`_`·`\` 리터럴이 와일드카드로 확장되지 않음(이스케이프 단일 지점) ⑥ 길이 1자·51자 → 빈 결과, 공백만 → 빈 결과
 *     ⑦ page_size 0/999/null → 1/50/20 클램프 ⑧ 인덱스 2개 존재 ⑨ 함수가 security invoker·stable.
 *  C. `--live` — 실제 Supabase(anon key, PostgREST)에서 RPC + `profiles(...)` 임베딩이 붙는지·키셋이 이어지는지.
 *     migration 이 적용된 DB 에서만 통과한다(①migration apply 직후 게이트).
 *
 * 사용법:
 *   npx tsx scripts/qa/community-search-smoke.ts            # A + B (네트워크 없음)
 *   npx tsx scripts/qa/community-search-smoke.ts --live     # A + B + C (.env.local 필요)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { feedKeyFor, normalizeSearchQuery, SEARCH_MIN_LEN } from "../../src/lib/community/feed-search";

let pass = 0;
let fail = 0;
async function t(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}

const MIGRATION = path.resolve(process.cwd(), "supabase/migrations/20260905160000_posts_search_trgm.sql");

async function sectionA() {
  console.log("A. 순수 함수");
  await t("normalize: trim 만, 이스케이프 없음", () => {
    assert.equal(normalizeSearchQuery("  직관 %_\\ "), "직관 %_\\");
  });
  await t(`normalize: ${SEARCH_MIN_LEN}자 미만·공백·null → null`, () => {
    assert.equal(normalizeSearchQuery("ㄱ"), null);
    assert.equal(normalizeSearchQuery("   "), null);
    assert.equal(normalizeSearchQuery(""), null);
    assert.equal(normalizeSearchQuery(null), null);
    assert.equal(normalizeSearchQuery(undefined), null);
  });
  await t("feedKey: 무검색 전체글은 기존 'all' 그대로(복원 상태 호환)", () => {
    assert.equal(feedKeyFor({ kind: "all" }), "all");
    assert.equal(feedKeyFor({ kind: "all", q: "" }), "all");
    assert.equal(feedKeyFor({ kind: "all", q: "ㄱ" }), "all");
  });
  await t("feedKey: 검색어별 키 분리 → 커서·복원 상태 분리", () => {
    assert.equal(feedKeyFor({ kind: "all", q: "직관" }), "all:q=직관");
    assert.notEqual(feedKeyFor({ kind: "all", q: "직관" }), feedKeyFor({ kind: "all", q: "직관러" }));
    assert.equal(feedKeyFor({ kind: "all", q: " 직관 " }), "all:q=직관");
  });
  await t("feedKey: 팀/선수 키 불변", () => {
    assert.equal(feedKeyFor({ kind: "team", teamId: "lg" }), "team:lg");
    assert.equal(feedKeyFor({ kind: "player", kboId: "12345" }), "player:12345");
  });
}

type Row = { id: number; title: string | null; content: string | null };

async function sectionB() {
  console.log("B. search_posts (PGlite + pg_trgm, migration 원문 적용)");
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.waitReady;
  // 함수가 참조하는 컬럼만 가진 최소 posts. 실제 스키마의 나머지 컬럼은 `p.*` 로 투과되므로 의미 검증에 영향 없음.
  await db.exec(`
    create table public.posts (
      id bigserial primary key,
      author_id uuid,
      board_type text not null,
      board_id text,
      title text,
      content text,
      is_hidden boolean default false,
      created_at timestamptz default now()
    );
  `);
  // Supabase 기본 롤(grant 대상)은 PGlite 에 없으므로 미리 만든다 — migration 원문은 건드리지 않는다.
  await db.exec("create role anon; create role authenticated;");
  try {
    await db.exec(readFileSync(MIGRATION, "utf8"));
  } catch (e) {
    throw new Error(`migration 적용 실패: ${(e as Error).message}`);
  }

  const ins = async (board_type: string, title: string | null, content: string | null, hidden = false) => {
    const r = await db.query<{ id: number }>(
      "insert into public.posts (board_type, title, content, is_hidden) values ($1,$2,$3,$4) returning id",
      [board_type, title, content, hidden],
    );
    return Number(r.rows[0].id);
  };
  const search = async (q: string | null, before: number | null = null, size: number | null = 20) =>
    (await db.query<Row>("select id, title, content from public.search_posts($1, $2, $3)", [q, before, size])).rows.map(
      (r) => ({ ...r, id: Number(r.id) }),
    );

  const idTitle = await ins("free", "잠실 직관 후기", "재밌었다");
  const idBody = await ins("team", "오늘 경기", "직관러 모여라");
  const idUpper = await ins("free", "LG Twins", "go go");
  await ins("free", "숨김 직관", "직관", true);
  await ins("notice", "직관 공지", "직관 — board_type 비허용");
  const idPct = await ins("free", "할인 50% 이벤트", "x");
  const idUnder = await ins("free", "snake_case 글", "x");
  const idBack = await ins("free", "역슬래시 \\ 포함", "x");
  const idPlain = await ins("free", "할인 50 이벤트", "x"); // % 없음 — '%' 검색에 잡히면 와일드카드 확장

  await t("① 제목 매치 + 본문 매치, 대소문자 무시", async () => {
    const ids = (await search("직관")).map((r) => r.id);
    assert.ok(ids.includes(idTitle) && ids.includes(idBody), `ids=${ids}`);
    assert.deepEqual((await search("lg tw")).map((r) => r.id), [idUpper]);
  });
  await t("② is_hidden 제외 ③ 비허용 board_type 제외", async () => {
    const rows = await search("직관");
    assert.equal(rows.some((r) => r.title === "숨김 직관"), false);
    assert.equal(rows.some((r) => r.title === "직관 공지"), false);
  });
  await t("⑤ '%' '_' '\\' 리터럴은 와일드카드로 확장되지 않는다(이스케이프 단일 지점)", async () => {
    assert.deepEqual((await search("50%")).map((r) => r.id), [idPct]);
    assert.deepEqual((await search("e_c")).map((r) => r.id), [idUnder]);
    assert.deepEqual((await search("\\ 포")).map((r) => r.id), [idBack]);
    assert.equal((await search("50%")).some((r) => r.id === idPlain), false);
  });
  await t("⑥ 길이 가드: 1자·51자·공백만·null → 빈 결과(에러 아님)", async () => {
    assert.deepEqual(await search("직"), []);
    assert.deepEqual(await search("가".repeat(51)), []);
    assert.deepEqual(await search("   "), []);
    assert.deepEqual(await search(null), []);
    // 앞뒤 공백은 trim 뒤 판정 → 2자면 검색된다
    assert.ok((await search("  직관  ")).length >= 2);
  });

  // 키셋: 같은 검색어로 30건 만들어 20 + 10 으로 이어지는지
  const bulk: number[] = [];
  for (let i = 0; i < 30; i++) bulk.push(await ins("free", `키셋 테스트 ${i}`, "keyset"));
  await t("④ id desc 키셋: 1페이지 20 → before_id 로 2페이지 10, 중복 0, 순서 내림차순", async () => {
    const p1 = await search("키셋 테스트", null, 20);
    assert.equal(p1.length, 20);
    for (let i = 1; i < p1.length; i++) assert.ok(p1[i - 1].id > p1[i].id, "desc");
    const p2 = await search("키셋 테스트", p1[p1.length - 1].id, 20);
    assert.equal(p2.length, 10);
    const all = new Set([...p1, ...p2].map((r) => r.id));
    assert.equal(all.size, 30);
    assert.deepEqual([...all].sort((a, b) => a - b), bulk.sort((a, b) => a - b));
    assert.deepEqual(await search("키셋 테스트", p2[p2.length - 1].id, 20), []);
  });
  await t("⑦ page_size 클램프: 0→1, 999→50, null→20", async () => {
    assert.equal((await search("키셋 테스트", null, 0)).length, 1);
    assert.equal((await search("키셋 테스트", null, 999)).length, 30); // 30건뿐 → 상한 50 안
    for (let i = 0; i < 25; i++) await ins("free", `키셋 테스트 extra ${i}`, "keyset");
    assert.equal((await search("키셋 테스트", null, 999)).length, 50);
    assert.equal((await search("키셋 테스트", null, null)).length, 20);
  });
  await t("⑧ 트리그램 GIN 인덱스 2개 존재", async () => {
    const r = await db.query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where tablename='posts' and indexname like 'idx_posts_%_trgm' order by 1",
    );
    assert.deepEqual(
      r.rows.map((x) => x.indexname),
      ["idx_posts_content_trgm", "idx_posts_title_trgm"],
    );
    for (const x of r.rows) assert.match(x.indexdef, /USING gin .*gin_trgm_ops/);
  });
  await t("⑨ 함수 속성: security invoker(prosecdef=false)·stable·search_path 고정", async () => {
    const r = await db.query<{ prosecdef: boolean; provolatile: string; proconfig: string[] | null }>(
      "select prosecdef, provolatile, proconfig from pg_proc where proname='search_posts'",
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].prosecdef, false);
    assert.equal(r.rows[0].provolatile, "s");
    assert.ok((r.rows[0].proconfig ?? []).some((c) => c.startsWith("search_path=")));
  });
  await db.close();
}

async function sectionC() {
  console.log("C. --live: Supabase PostgREST RPC + profiles 임베딩");
  const { createClient } = await import("@supabase/supabase-js");
  const env = await import("./_env.mjs");
  const anon = createClient(env.SUPABASE_URL, env.ANON, { auth: { persistSession: false } });
  const SELECT =
    "id, author_id, board_type, title, content, is_hidden, created_at, profiles(nickname, team_id, grade, points, avatar_url)";
  // 운영 데이터에 흔한 2자 검색어. 결과 0 이면 임베딩 검증이 불가하므로 후보를 순서대로 시도한다.
  const candidates = (process.env.LIVE_Q ?? "직관,오늘,경기,선수").split(",");
  let rows: Array<Record<string, unknown>> = [];
  let used = "";
  for (const q of candidates) {
    const { data, error } = await anon.rpc("search_posts", { q, before_id: null, page_size: 20 }).select(SELECT);
    if (error) throw new Error(`rpc error: ${error.message}`);
    if (data && data.length) {
      rows = data as Array<Record<string, unknown>>;
      used = q;
      break;
    }
  }
  await t(`anon RPC 호출 성공 + 결과 존재 (q=${used || "none"})`, () => {
    assert.ok(rows.length > 0, "후보 검색어 전부 0건 — LIVE_Q 로 검색어 지정");
  });
  await t("profiles 임베딩이 RPC 결과에 붙는다", () => {
    const withProfile = rows.filter((r) => r.profiles && typeof r.profiles === "object");
    assert.ok(withProfile.length > 0, "profiles 임베딩 없음");
  });
  await t("숨김글 없음·허용 board_type 만·id desc", () => {
    for (const r of rows) assert.notEqual(r.is_hidden, true);
    for (const r of rows) assert.ok(["team", "player", "free", "poll"].includes(String(r.board_type)));
    for (let i = 1; i < rows.length; i++) assert.ok(Number(rows[i - 1].id) > Number(rows[i].id));
  });
  await t("2페이지 키셋 연속(중복 0)", async () => {
    if (rows.length < 20) return; // 1페이지로 끝나면 키셋 검증 대상 아님
    const last = Number(rows[rows.length - 1].id);
    const { data, error } = await anon.rpc("search_posts", { q: used, before_id: last, page_size: 20 }).select("id");
    if (error) throw new Error(error.message);
    const ids1 = new Set(rows.map((r) => Number(r.id)));
    for (const r of data ?? []) {
      assert.ok(!ids1.has(Number((r as { id: number }).id)), "중복");
      assert.ok(Number((r as { id: number }).id) < last, "before_id 미만");
    }
  });
  await t("길이 1자 → 빈 결과(에러 아님)", async () => {
    const { data, error } = await anon.rpc("search_posts", { q: "직", before_id: null, page_size: 20 }).select("id");
    assert.equal(error, null);
    assert.deepEqual(data, []);
  });
}

(async () => {
  await sectionA();
  await sectionB();
  if (process.argv.includes("--live")) await sectionC();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
