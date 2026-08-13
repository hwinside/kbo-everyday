/**
 * advisor-step2-rls-gate — RLS initplan 67건 + 중복 permissive 26건 migration 지속 회귀
 *
 * 픽스처(전부 production 기계 추출, 2026-08-13):
 *  - rls-policies-baseline-20260813.json  (pg_policies 103건)
 *  - rls-table-columns-20260813.json      (public 테이블 140개 컬럼)
 *
 * PGlite(실제 Postgres)에 fixture 스키마+정책을 재구성하고 migration 파일을
 * **그대로** replay 한다.
 *  A1 prod-like replay 성공
 *  A2 advisor 술어: bare auth.<fn>() 잔존 0 (래핑 발생부 제거 후 잔여 검사)
 *  A3 Part A 정책: cmd·roles·permissive 불변 + 래핑 완료
 *  A4 Part B: service 정책 4건 roles={service_role}, DELETE 병합 정책 존재·구정책 소멸
 *  A5 대상 6테이블에서 anon/authenticated의 (action)별 permissive 정책 수 ≤ 1
 *  A6 동작 동일성: posts/comments DELETE (작성자/운영자/타인/anon) before=after
 *  A7 mutation RED: 정책 drift 주입 → EXCEPTION으로 전체 거부
 *  A8 멱등: 같은 migration 2회 실행 성공 (이미 래핑 → skip)
 *  A9 clean-chain: 빈 DB replay 성공 (no-op)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const ROOT = join(__dirname, "..", "..");
const MIGRATION = join(ROOT, "supabase", "migrations", "20260813_advisor_step2_rls_initplan.sql");
const POLICIES = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "rls-policies-baseline-20260813.json"), "utf8"),
) as Array<{
  tablename: string;
  policyname: string;
  permissive: string;
  roles: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
}>;
const COLUMNS = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "rls-table-columns-20260813.json"), "utf8"),
) as Array<{ tablename: string; colname: string; coltype: string; attnum: number }>;

const migrationSql = readFileSync(MIGRATION, "utf8");

let failed = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`[PASS] ${name}`);
  else {
    failed += 1;
    console.error(`[FAIL] ${name}`, detail ?? "");
  }
}

function q(ident: string): string {
  return '"' + ident.replace(/"/g, '""') + '"';
}

function parseRoles(rolesText: string): string[] {
  return rolesText
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((r) => r.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

const SETUP_SQL = `
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
    $$ SELECT coalesce(nullif(current_setting('test.role', true), ''), 'anon') $$;
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
    $$ SELECT coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
  CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('test.email', true), '') $$;
  CREATE FUNCTION public.leaderboard_internal_user_ids() RETURNS uuid[]
    LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::uuid[] $$;
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;
  GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
`;

function buildTablesSql(): string {
  const byTable = new Map<string, Array<{ colname: string; coltype: string; attnum: number }>>();
  for (const c of COLUMNS) {
    if (!byTable.has(c.tablename)) byTable.set(c.tablename, []);
    byTable.get(c.tablename)!.push(c);
  }
  const stmts: string[] = [];
  for (const [tbl, cols] of byTable) {
    cols.sort((a, b) => a.attnum - b.attnum);
    // pgvector 등 PGlite 미탑재 확장 타입은 text로 치환 — 정책 표현식이 참조하지 않는
    // 컴럼이므로 게이트 판정에 영향 없음 (참조 시 CREATE POLICY가 즉시 실패하므로 fail-close)
    const colDefs = cols
      .map((c) => `${q(c.colname)} ${/^vector\b/.test(c.coltype) ? "text" : c.coltype}`)
      .join(", ");
    stmts.push(`CREATE TABLE public.${q(tbl)} (${colDefs});`);
    stmts.push(`ALTER TABLE public.${q(tbl)} ENABLE ROW LEVEL SECURITY;`);
    stmts.push(`GRANT ALL ON public.${q(tbl)} TO anon, authenticated, service_role;`);
  }
  return stmts.join("\n");
}

function createPolicySql(p: (typeof POLICIES)[number]): string {
  const roles = parseRoles(p.roles);
  const toClause = roles.length === 1 && roles[0] === "public" ? "" : ` TO ${roles.map(q).join(", ")}`;
  const cmd = p.cmd === "ALL" ? "ALL" : p.cmd;
  let s = `CREATE POLICY ${q(p.policyname)} ON public.${q(p.tablename)} AS ${p.permissive} FOR ${cmd}${toClause}`;
  if (p.qual) s += ` USING (${p.qual})`;
  if (p.with_check) s += ` WITH CHECK (${p.with_check})`;
  return s + ";";
}

async function prodLikeDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SETUP_SQL);
  await db.exec(buildTablesSql());
  for (const p of POLICIES) await db.exec(createPolicySql(p));
  return db;
}

async function replay(db: PGlite): Promise<{ ok: boolean; error: string }> {
  try {
    await db.exec(migrationSql);
    return { ok: true, error: "" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// advisor 술어: 래핑된 SELECT auth.<fn>() 발생부를 제거한 뒤 bare 호출 잔존 검사
const BARE_AUTH_COUNT_SQL = `
  SELECT count(*)::int AS n FROM pg_policies
  WHERE schemaname='public'
    AND regexp_replace(
          coalesce(qual,'') || ' ' || coalesce(with_check,''),
          '[Ss][Ee][Ll][Ee][Cc][Tt] auth\\.(uid|role|jwt|email)\\(\\)', '', 'g')
        ~ 'auth\\.(uid|role|jwt|email)\\(\\)'
`;

type PolicyRow = {
  tablename: string;
  policyname: string;
  permissive: string;
  roles: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
};

async function policyMap(db: PGlite): Promise<Map<string, PolicyRow>> {
  const r = await db.query<PolicyRow>(
    "select tablename, policyname, permissive, roles::text as roles, cmd, qual, with_check from pg_policies where schemaname='public'",
  );
  return new Map(r.rows.map((p) => [`${p.tablename}|${p.policyname}`, p]));
}

const PART_B_SERVICE = [
  ["announcements", "Service role full access on announcements"],
  ["channel_pool", "channel_pool_service_write"],
  ["videos", "videos_service_write"],
  ["highlights", "highlights_write"],
] as const;
const PART_B_MERGED = [
  ["comments", "comments_delete_author_or_operator", "Authors delete own comments", "Operators delete any comments"],
  ["posts", "posts_delete_author_or_operator", "Authors delete own posts", "Operators delete any posts"],
] as const;
const PART_B_OLD = new Set([
  "comments|Authors delete own comments",
  "comments|Operators delete any comments",
  "posts|Authors delete own posts",
  "posts|Operators delete any posts",
]);
const TARGET_TABLES = ["announcements", "channel_pool", "videos", "highlights", "comments", "posts"];

// ---- 동작 동일성 스모크 (posts/comments DELETE) ---------------------------
const AUTHOR = "11111111-1111-4111-8111-111111111111";
const OPERATOR = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

async function deleteBehavior(db: PGlite, table: "posts" | "comments"): Promise<string> {
  // 각 시나리오: 행 3개 재시드 → actor로 DELETE 시도 → 남은 행 관찰
  const outcomes: string[] = [];
  const scenarios: Array<{ label: string; role: string; uid: string | null }> = [
    { label: "author", role: "authenticated", uid: AUTHOR },
    { label: "operator", role: "authenticated", uid: OPERATOR },
    { label: "other", role: "authenticated", uid: OTHER },
    { label: "anon", role: "anon", uid: null },
  ];
  for (const sc of scenarios) {
    await db.exec(`
      DELETE FROM public.${table} WHERE true;
      INSERT INTO public.${table} (id, author_id) VALUES
        (1, '${AUTHOR}'::uuid),
        (2, '${OPERATOR}'::uuid);
    `);
    await db.exec(`
      SET ROLE ${sc.role};
      SELECT set_config('test.uid', '${sc.uid ?? ""}', false);
      SELECT set_config('test.role', '${sc.role}', false);
    `);
    let deleted: number;
    try {
      const r = await db.query<{ n: number }>(
        `WITH d AS (DELETE FROM public.${table} WHERE true RETURNING 1) SELECT count(*)::int AS n FROM d`,
      );
      deleted = r.rows[0].n;
    } catch {
      deleted = -1;
    }
    await db.exec("RESET ROLE; SELECT set_config('test.uid','',false); SELECT set_config('test.role','',false);");
    outcomes.push(`${sc.label}=${deleted}`);
  }
  return outcomes.join(",");
}

async function setupBehaviorFixture(db: PGlite) {
  // posts/comments: id·author_id 사용. profiles: 운영자 판정.
  await db.exec(`
    ALTER TABLE public.posts FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.comments FORCE ROW LEVEL SECURITY;
    INSERT INTO public.profiles (id, is_operator) VALUES
      ('${AUTHOR}'::uuid, false), ('${OPERATOR}'::uuid, true), ('${OTHER}'::uuid, false);
  `);
}

async function main() {
  // --- baseline 동작 스냅샷 (migration 전)
  let baselinePosts = "";
  let baselineComments = "";
  {
    const db = await prodLikeDb();
    await setupBehaviorFixture(db);
    baselinePosts = await deleteBehavior(db, "posts");
    baselineComments = await deleteBehavior(db, "comments");
    await db.close();
  }
  assert("A6-pre baseline behavior sane (author=1, operator=2, other=0, anon=0)",
    baselinePosts === "author=1,operator=2,other=0,anon=0", baselinePosts);

  // --- A1~A6, A8: prod-like replay
  {
    const db = await prodLikeDb();
    await setupBehaviorFixture(db);
    const r = await replay(db);
    assert("A1 prod-like replay succeeds", r.ok, r.error);

    const bare = await db.query<{ n: number }>(BARE_AUTH_COUNT_SQL);
    assert("A2 bare auth calls remaining = 0", bare.rows[0].n === 0, bare.rows[0].n);

    const after = await policyMap(db);
    // A3: Part A 정책 cmd/roles/permissive 불변
    let structOk = true;
    const structDiffs: string[] = [];
    for (const p of POLICIES) {
      const key = `${p.tablename}|${p.policyname}`;
      if (PART_B_OLD.has(key)) continue;
      const isServiceScoped = PART_B_SERVICE.some(([t, n]) => t === p.tablename && n === p.policyname);
      const now = after.get(key);
      if (!now) {
        structOk = false;
        structDiffs.push(`missing ${key}`);
        continue;
      }
      const expectedRoles = isServiceScoped ? "{service_role}" : p.roles;
      if (now.cmd !== p.cmd || now.permissive !== p.permissive || now.roles !== expectedRoles) {
        structOk = false;
        structDiffs.push(`changed ${key}: ${now.cmd}/${now.permissive}/${now.roles}`);
      }
    }
    assert("A3 policy structure preserved (cmd/permissive/roles)", structOk, structDiffs.slice(0, 5));

    // A4: Part B
    for (const [tbl, name] of PART_B_SERVICE) {
      const now = after.get(`${tbl}|${name}`);
      assert(`A4 ${tbl}.${name} scoped to service_role`, now?.roles === "{service_role}", now?.roles);
    }
    for (const [tbl, merged, oldA, oldB] of PART_B_MERGED) {
      assert(`A4 ${tbl} merged policy exists (FOR DELETE)`, after.get(`${tbl}|${merged}`)?.cmd === "DELETE");
      assert(`A4 ${tbl} old pair dropped`, !after.has(`${tbl}|${oldA}`) && !after.has(`${tbl}|${oldB}`));
    }

    // A5: 대상 테이블 permissive 중복 해소 (anon/authenticated × action)
    const overlap = await db.query<{ tablename: string; role: string; action: string; n: number }>(`
      WITH expanded AS (
        SELECT tablename, unnest(CASE WHEN cmd='ALL' THEN ARRAY['SELECT','INSERT','UPDATE','DELETE'] ELSE ARRAY[cmd] END) AS action,
               r.role
        FROM pg_policies, LATERAL (SELECT unnest(ARRAY['anon','authenticated']) AS role) r
        WHERE schemaname='public' AND permissive='PERMISSIVE'
          AND (roles = '{public}'::name[] OR r.role::name = ANY(roles))
          AND tablename = ANY($1)
      )
      SELECT tablename, role, action, count(*)::int AS n
      FROM expanded GROUP BY 1,2,3 HAVING count(*) > 1
    `, [TARGET_TABLES]);
    assert("A5 no multiple permissive policies on target tables", overlap.rows.length === 0, overlap.rows);

    // A6: 동작 동일성
    const postsAfter = await deleteBehavior(db, "posts");
    const commentsAfter = await deleteBehavior(db, "comments");
    assert("A6 posts DELETE behavior identical", postsAfter === baselinePosts, { before: baselinePosts, after: postsAfter });
    assert("A6 comments DELETE behavior identical", commentsAfter === baselineComments, { before: baselineComments, after: commentsAfter });

    // A8: 멱등 재실행
    const r2 = await replay(db);
    assert("A8 idempotent re-run succeeds", r2.ok, r2.error);
    const bare2 = await db.query<{ n: number }>(BARE_AUTH_COUNT_SQL);
    assert("A8 still 0 bare calls", bare2.rows[0].n === 0);
    await db.close();
  }

  // --- A7 mutation RED: drift 주입 → 거부
  {
    const db = await prodLikeDb();
    await db.exec(`ALTER POLICY "blocks_select" ON public.user_blocks USING (auth.uid() IS NOT NULL);`);
    const r = await replay(db);
    assert("A7 drifted policy → EXCEPTION (RED)", !r.ok, "migration must refuse");
    assert("A7 error names drift", /drift/i.test(r.error), r.error.slice(0, 200));
    await db.close();
  }

  // --- A9 clean-chain: 빈 DB → no-op 성공
  {
    const db = new PGlite();
    await db.exec("CREATE SCHEMA IF NOT EXISTS auth;");
    const r = await replay(db);
    assert("A9 clean-chain (empty db) replay succeeds", r.ok, r.error);
    await db.close();
  }

  console.log(failed === 0 ? "\nAll advisor-step2 RLS gate tests PASSED" : `\n${failed} test(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
