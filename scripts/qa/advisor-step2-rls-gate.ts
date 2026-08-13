/**
 * advisor-step2-rls-gate — RLS initplan 67건 migration(2A 전용) 지속 회귀
 *
 * 픽스처(전부 production 기계 추출, 2026-08-13):
 *  - rls-policies-baseline-20260813.json  (pg_policies 103건)
 *  - rls-table-columns-20260813.json      (public 테이블 140개 컬럼)
 *
 * PGlite(실제 Postgres)에 fixture 스키마+정책을 재구성하고 migration 파일을
 * **그대로** replay 한다. (삼순 1차 NO-GO 반영: 2A 분리 · full fingerprint
 * fail-close · 실행형 rollback roundtrip)
 *  A1 prod-like replay 성공
 *  A2 advisor 술어: bare auth.<fn>() 잔존 0
 *  A3 67건 전부: cmd·permissive·roles 불변 + 래핑 완료, 나머지 36건 fingerprint 완전 불변
 *  A6 동작 동일성: posts DELETE(작성자/타인/anon) before=after
 *  A7 mutation RED: USING(true) 변조(bare auth 없음) → EXCEPTION으로 전체 거부
 *  A8 mutation RED: 이미 적용된 DB에 재실행(이중 적용) → EXCEPTION
 *  A9 clean-chain: 빈 DB replay 성공 (no-op)
 *  A10 rollback roundtrip: replay → rollback.sql 실행 → 103건 전부 baseline
 *      fingerprint로 완전 복원
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const ROOT = join(__dirname, "..", "..");
const MIGRATION = join(ROOT, "supabase", "migrations", "20260813_advisor_step2_rls_initplan.sql");
const ROLLBACK = join(ROOT, "scripts", "db", "rollback-advisor-step2-rls-initplan.sql");
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
const rollbackSql = readFileSync(ROLLBACK, "utf8");

// initplan 대상 판정(생성기와 동일 규칙) — 래핑 발생부('T '/'t ' 선행)는 제외
const BARE_AUTH = /(?<![Tt] )auth\.(uid|role|jwt|email)\(\)/;
const isTarget = (p: (typeof POLICIES)[number]) =>
  BARE_AUTH.test(p.qual ?? "") || BARE_AUTH.test(p.with_check ?? "");
const TARGETS = POLICIES.filter(isTarget);
const NON_TARGETS = POLICIES.filter((p) => !isTarget(p));

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
    // 컬럼이므로 게이트 판정에 영향 없음 (참조 시 CREATE POLICY가 즉시 실패하므로 fail-close)
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
  let s = `CREATE POLICY ${q(p.policyname)} ON public.${q(p.tablename)} AS ${p.permissive} FOR ${p.cmd}${toClause}`;
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

async function run(db: PGlite, sql: string): Promise<{ ok: boolean; error: string }> {
  try {
    await db.exec(sql);
    return { ok: true, error: "" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

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

function fpOf(p: { cmd: string; permissive: string; roles: string; qual: string | null; with_check: string | null }): string {
  return [p.cmd, p.permissive, p.roles, p.qual ?? "", p.with_check ?? ""].join("|");
}

// ---- 동작 동일성 스모크 (posts 작성자 DELETE — 래핑 대상 정책) ---------------
const AUTHOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";

async function deleteBehavior(db: PGlite): Promise<string> {
  const outcomes: string[] = [];
  const scenarios: Array<{ label: string; role: string; uid: string | null }> = [
    { label: "author", role: "authenticated", uid: AUTHOR },
    { label: "other", role: "authenticated", uid: OTHER },
    { label: "anon", role: "anon", uid: null },
  ];
  for (const sc of scenarios) {
    await db.exec(`
      DELETE FROM public.posts WHERE true;
      INSERT INTO public.posts (id, author_id) VALUES (1, '${AUTHOR}'::uuid);
    `);
    await db.exec(`
      SET ROLE ${sc.role};
      SELECT set_config('test.uid', '${sc.uid ?? ""}', false);
      SELECT set_config('test.role', '${sc.role}', false);
    `);
    let deleted: number;
    try {
      const r = await db.query<{ n: number }>(
        "WITH d AS (DELETE FROM public.posts WHERE true RETURNING 1) SELECT count(*)::int AS n FROM d",
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
  await db.exec(`
    ALTER TABLE public.posts FORCE ROW LEVEL SECURITY;
    INSERT INTO public.profiles (id, is_operator) VALUES ('${AUTHOR}'::uuid, false), ('${OTHER}'::uuid, false);
  `);
}

async function main() {
  assert("T0 initplan 대상 67건 (생성기와 동일 규칙)", TARGETS.length === 67, TARGETS.length);

  // --- baseline 동작 스냅샷
  let baselineBehavior = "";
  {
    const db = await prodLikeDb();
    await setupBehaviorFixture(db);
    baselineBehavior = await deleteBehavior(db);
    await db.close();
  }
  assert("A6-pre baseline behavior sane (author=1, other=0, anon=0)",
    baselineBehavior === "author=1,other=0,anon=0", baselineBehavior);

  // --- A1~A6: prod-like replay
  {
    const db = await prodLikeDb();
    await setupBehaviorFixture(db);
    const before = await policyMap(db);
    const r = await run(db, migrationSql);
    assert("A1 prod-like replay succeeds", r.ok, r.error);

    const bare = await db.query<{ n: number }>(BARE_AUTH_COUNT_SQL);
    assert("A2 bare auth calls remaining = 0", bare.rows[0].n === 0, bare.rows[0].n);

    const after = await policyMap(db);
    assert("A3 policy count unchanged", after.size === POLICIES.length, after.size);
    // 67건: cmd/permissive/roles 불변 + qual/check에 래핑 존재
    let structOk = true;
    const diffs: string[] = [];
    for (const p of TARGETS) {
      const key = `${p.tablename}|${p.policyname}`;
      const now = after.get(key);
      if (!now || now.cmd !== p.cmd || now.permissive !== p.permissive || now.roles !== p.roles) {
        structOk = false;
        diffs.push(key);
      }
    }
    assert("A3 67건 cmd/permissive/roles 불변", structOk, diffs.slice(0, 5));
    // 나머지 36건: fingerprint 완전 불변
    let untouched = true;
    const touchedDiffs: string[] = [];
    for (const p of NON_TARGETS) {
      const key = `${p.tablename}|${p.policyname}`;
      const now = after.get(key);
      const beforeRow = before.get(key);
      if (!now || !beforeRow || fpOf(now) !== fpOf(beforeRow)) {
        untouched = false;
        touchedDiffs.push(key);
      }
    }
    assert("A3 비대상 36건 fingerprint 완전 불변", untouched, touchedDiffs.slice(0, 5));

    const behaviorAfter = await deleteBehavior(db);
    assert("A6 posts DELETE behavior identical", behaviorAfter === baselineBehavior,
      { before: baselineBehavior, after: behaviorAfter });

    // --- A8: 이미 적용된 DB에 재실행 → 전건 fingerprint 불일치 → 거부
    const r2 = await run(db, migrationSql);
    assert("A8 re-run on applied db → EXCEPTION (이중 적용 거부)", !r2.ok);
    assert("A8 error names fingerprint drift", /fingerprint drift/i.test(r2.error), r2.error.slice(0, 150));

    // --- A10: rollback roundtrip — 원상 복원
    const rb = await run(db, rollbackSql);
    assert("A10 rollback executes", rb.ok, rb.error);
    const restored = await policyMap(db);
    let roundtripOk = true;
    const rtDiffs: string[] = [];
    for (const p of POLICIES) {
      const key = `${p.tablename}|${p.policyname}`;
      const now = restored.get(key);
      if (!now || fpOf(now) !== fpOf(p)) {
        roundtripOk = false;
        rtDiffs.push(key);
      }
    }
    assert("A10 rollback roundtrip: 103건 전부 baseline fingerprint 복원", roundtripOk, rtDiffs.slice(0, 5));
    // roundtrip 후 재적용도 가능해야 함 (fingerprint가 baseline과 다시 일치)
    const r3 = await run(db, migrationSql);
    assert("A10 re-apply after rollback succeeds", r3.ok, r3.error);
    await db.close();
  }

  // --- A7 mutation RED: USING(true) 변조 (bare auth 없음) → 거부
  {
    const db = await prodLikeDb();
    await db.exec(`ALTER POLICY "blocks_select" ON public.user_blocks USING (true);`);
    const r = await run(db, migrationSql);
    assert("A7 tampered policy USING(true) → EXCEPTION (RED)", !r.ok, "migration must refuse");
    assert("A7 error names fingerprint drift", /fingerprint drift/i.test(r.error), r.error.slice(0, 150));
    await db.close();
  }

  // --- A9 clean-chain: 빈 DB → no-op 성공
  {
    const db = new PGlite();
    const r = await run(db, migrationSql);
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
