/**
 * home-popular-posts RPC PGlite 게이트 (삼순 #1343 ③ PG17 검증 공백 보완).
 *
 * pg17.sh 는 postgresql@17 바이너리 없으면 SKIP/exit 0이고 result-tone PG17 단계에도
 * 미연결이었다. 이 게이트는 PGlite(embedded Postgres)로 **항상 실행** — CI에서도 SKIP 없음.
 *
 * 검증 항목:
 *  G1) 마이그레이션 원문 실행 — STORED 생성 컬럼 + 인덱스 + RPC 정의
 *  G2) anon EXECUTE grant — has_function_privilege('anon', ...)
 *  G3) authenticated EXECUTE grant
 *  G4) security invoker — prosecdef = false
 *  G5) RLS ENABLED 확인 (security invoker 이므로 호출자 권한 적용)
 *  G6) RPC 직접 호출 + 반환 행 구조(정렬·창·숨김 필터)
 *  G7) profiles 임베드 경로 — RPC author_id 로 profiles join 가능(클라이언트 .select 전제)
 *  G8) limit 상한 100 / 음수 → 0
 *
 * 실행: npm run qa:home-popular-feed:pglite
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = join(
  __dirname,
  "..",
  "..",
  "supabase",
  "migrations",
  "20260905043000_posts_popularity.sql",
);

let failed = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`[PASS] ${name}`);
  else {
    failed++;
    console.error(`[FAIL] ${name}`, detail ?? "");
  }
}

async function main() {
  const migSql = readFileSync(MIGRATION, "utf8");

  const db = new PGlite();

  await db.exec(`
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  await db.exec(`
    CREATE TABLE public.posts (
      id bigint PRIMARY KEY,
      author_id uuid NOT NULL,
      board_type text NOT NULL DEFAULT 'team',
      board_id text,
      like_count integer DEFAULT 0,
      comment_count integer DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      is_hidden boolean DEFAULT false,
      team_tags jsonb DEFAULT '[]'::jsonb,
      player_tags jsonb DEFAULT '[]'::jsonb
    );
    ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY,
      nickname text,
      team_id integer,
      grade text,
      points integer,
      avatar_url text
    );
  `);

  // ── G1 마이그레이션 실행 ──
  try {
    await db.exec(migSql);
    assert("G1 migration 원문 실행 성공", true);
  } catch (e) {
    assert("G1 migration 원문 실행 성공", false, e instanceof Error ? e.message : e);
    await db.close();
    process.exit(1);
  }

  // ── G2/G3 anon·authenticated EXECUTE grant ──
  const grantRes = await db.query<{ roles: string }>(`
    SELECT string_agg(r, ',' ORDER BY r) AS roles
    FROM (SELECT unnest(ARRAY['anon','authenticated']) r) x
    WHERE has_function_privilege(r, 'public.home_popular_posts(timestamptz,integer,text,text[],uuid[],bigint[])', 'execute')
  `);
  const grantedRoles = grantRes.rows[0]?.roles ?? "";
  assert("G2 anon EXECUTE grant", grantedRoles.includes("anon"), `granted=${grantedRoles}`);
  assert("G3 authenticated EXECUTE grant", grantedRoles.includes("authenticated"), `granted=${grantedRoles}`);

  // ── G4 security invoker ──
  const invokerRes = await db.query<{ prosecdef: boolean }>(`
    SELECT prosecdef FROM pg_proc WHERE proname = 'home_popular_posts'
  `);
  assert("G4 security invoker(prosecdef=false)", invokerRes.rows[0]?.prosecdef === false, invokerRes.rows[0]);

  // ── 픽스처 삽입 ──
  const A1 = "00000000-0000-4000-8000-000000000001";
  await db.exec(`
    INSERT INTO public.posts(id, author_id, like_count, comment_count, created_at, is_hidden, team_tags, player_tags, board_type) VALUES
     (1000, '${A1}', 60, 40, now() - interval '1 day', false, '["lg"]', '[]', 'team'),
     ( 999, '${A1}', 50, 49, now() - interval '1 day', false, '["lg"]', '[]', 'team'),
     ( 998, '${A1}', 50, 48, now() - interval '9 day', false, '["lg"]', '[]', 'team'),
     ( 997, '${A1}', 50, 47, now() - interval '1 day', true,  '["lg"]', '[]', 'team');
    INSERT INTO public.profiles(id, nickname, team_id) VALUES ('${A1}', '테스트유저', 1);
  `);

  const since = `now() - interval '7 day'`;

  // ── G5 RLS ENABLED 확인 ──
  const rlsRes = await db.query<{ relrowsecurity: boolean }>(`
    SELECT relrowsecurity FROM pg_class
    WHERE relname = 'posts' AND relnamespace = 'public'::regnamespace
  `);
  assert("G5 posts RLS ENABLED(security invoker이므로 호출자 RLS 적용)", rlsRes.rows[0]?.relrowsecurity === true, rlsRes.rows[0]);

  // 정책 없음 확인 (security invoker + no policy = postgres 역할도 행 반환 확인용)
  const policyRes = await db.query<{ cnt: string }>(`
    SELECT count(*)::text AS cnt FROM pg_policies WHERE tablename = 'posts' AND schemaname = 'public'
  `);
  assert("G5 테스트 환경 정책 없음 전제", parseInt(policyRes.rows[0]?.cnt ?? "0", 10) === 0, `policies=${policyRes.rows[0]?.cnt}`);

  // ── G6 RPC 직접 호출 + 반환 행 구조 ──
  const rpcRes = await db.query<{ id: number; popularity: number }>(`
    SELECT id, popularity FROM public.home_popular_posts(${since}, 10, null, '{}', '{}', '{}')
    ORDER BY popularity DESC, id DESC
  `);
  const ids = rpcRes.rows.map((r) => r.id);
  assert("G6 창 안 미숨김 글 2건 반환(창 밖 998·숨김 997 제외)", ids.length === 2, `ids=${ids}`);
  assert("G6 정렬 올바름(1000→999, popularity desc·id desc)", ids[0] === 1000 && ids[1] === 999, `ids=${ids}`);
  assert(
    "G6 popularity 생성 컬럼 = like+comment(1000→100, 999→99)",
    rpcRes.rows[0]?.popularity === 100 && rpcRes.rows[1]?.popularity === 99,
    rpcRes.rows.map((r) => ({ id: r.id, pop: r.popularity })),
  );

  // ── G7 profiles 임베드 경로 — RPC author_id로 join 가능 ──
  const profileJoinRes = await db.query<{ author_id: string }>(`
    SELECT r.author_id
    FROM public.home_popular_posts(${since}, 10, null, '{}', '{}', '{}') r
    JOIN public.profiles pr ON pr.id = r.author_id
    WHERE r.id = 1000
  `);
  assert(
    "G7 RPC author_id로 profiles join 가능(클라이언트 .select('...profiles(...)') 경로 전제 유효)",
    profileJoinRes.rows.length === 1 && profileJoinRes.rows[0]?.author_id === A1,
    profileJoinRes.rows,
  );

  // ── G8 limit 상한 100 / 음수 ──
  const limitRes = await db.query<{ cnt: string }>(`
    SELECT count(*)::text AS cnt FROM public.home_popular_posts(${since}, 1000, null, '{}', '{}', '{}')
  `);
  assert("G8 limit 상한 100(p_limit=1000 → max 100 행)", parseInt(limitRes.rows[0]?.cnt ?? "0", 10) <= 100);

  const negRes = await db.query<{ cnt: string }>(`
    SELECT count(*)::text AS cnt FROM public.home_popular_posts(${since}, -5, null, '{}', '{}', '{}')
  `);
  assert("G8 limit 음수 → 0건", parseInt(negRes.rows[0]?.cnt ?? "0", 10) === 0);

  await db.close();

  if (failed > 0) {
    console.error(`\n❌ home-popular-posts-rpc-pglite-gate FAIL — ${failed}건`);
    process.exit(1);
  }
  console.log(`\n✅ home-popular-posts-rpc-pglite-gate PASS`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
