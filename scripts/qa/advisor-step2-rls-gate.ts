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
 *  A7b mutation RED: 테이블은 있는데 대상 policy만 부재 → EXCEPTION (부분 성공 차단)
 *  A8 mutation RED: 이미 적용된 DB에 재실행(이중 적용) → EXCEPTION
 *  A9 clean-chain: 빈 DB replay 성공 (no-op)
 *  A10 rollback roundtrip: replay → rollback.sql 실행 → 103건 전부 baseline
 *      fingerprint로 완전 복원 + 복원 후 재적용 성공
 *  A10b rollback-drift RED: 적용 후 정책 변조 → rollback 전건 거부
 *  A10c rollback-missing RED: 적용 후 정책 DROP → rollback 전건 거부
 *  A11 target 67/67 qual/with_check 오라클: post-migration 실측값을 이 파일이
 *      독립 구현한 wrap(문자 스캔, 생성기 python regex와 별개)으로 만든
 *      기대식을 PG deparse로 정규화한 오라클과 67/67 전건 대조
 *  A11b/A11c mutation RED: migration의 래핑식 1개를 true/다른 래핑식으로
 *      바꾼 mutant를 적용하면 오라클 대조가 검출(RED)
 *  --- 삼순 4차 NO-GO 반영 ---
 *  A12 lock-before-read: forward/rollback 모두 루프 본문에서 LOCK TABLE .. ACCESS
 *      EXCLUSIVE가 fingerprint SELECT보다 앞서는지 구조 판정 + lock 실효성(tx 내
 *      pg_locks에 대상 테이블 AccessExclusiveLock 실측). PGlite는 단일 커넥션이라
 *      실제 인터리브 재현은 불가 — 순서는 구조로, 실효성은 pg_locks로 고정한다.
 *  A12b/A12c mutation RED: LOCK 제거/SELECT 뒤로 재배치 mutant → 구조 판정이 검출
 *  A13 rollback-on-baseline RED: migration 미적용 baseline DB에 rollback → 전건 거부
 *      (구 unwrap→baseline 비교 가드는 이 상태를 통과시켰다 — exact post_fp 직접
 *      비교로 교체해 RED)
 *  A13b partial-bare RED: 적용 후 일부 정책만 bare로 원복된 상태에 rollback → 거부
 *  A10(기존)이 겸하는 검증: rollback은 생성기 예측 post_fp와 직접 비교하므로,
 *      roundtrip 67건 전건 성공 = 예측 deparse가 실제 post-state와 exact 일치 실측
 *  T-check 생성기 SSOT: generate --check로 committed 출력 byte 일치 고정 (spawn 실패도 FAIL)
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const ROOT = join(__dirname, "..", "..");
const MIGRATION = join(ROOT, "supabase", "migrations", "20260815130000_advisor_step2_rls_initplan.sql");
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

// 독립 wrap 구현 — 생성기(python regex)와 달리 문자 스캔으로 구현해 같은
// 오치환을 공유하지 않는다. bare auth.<fn>() 호출을 (select auth.<fn>())로 치환하되
// 직전이 'SELECT '/'select '인 발생부(이미 래핑)는 건너뀜다.
function tsWrap(expr: string): string {
  const FNS = ["uid", "role", "jwt", "email"];
  let out = "";
  let i = 0;
  while (i < expr.length) {
    let matched = false;
    if (expr.startsWith("auth.", i)) {
      for (const fn of FNS) {
        const call = `auth.${fn}()`;
        if (expr.startsWith(call, i)) {
          const prefix = expr.slice(Math.max(0, i - 7), i).toLowerCase();
          const wrappedAlready = prefix.endsWith("select ");
          out += wrappedAlready ? call : `(select auth.${fn}())`;
          i += call.length;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      out += expr[i];
      i += 1;
    }
  }
  return out;
}

/**
 * 오라클 구축: 별도 PGlite에 prod-like 스키마를 만들고, target 67건을
 * DROP → tsWrap 기대식으로 CREATE 해 PG deparse로 정규화된 기대 qual/with_check를
 * 추출한다. migration 경로(python wrap + ALTER)와 완전 분리된 경로다.
 */
async function buildOracle(): Promise<Map<string, { qual: string | null; with_check: string | null }>> {
  const db = await prodLikeDb();
  for (const p of TARGETS) {
    await db.exec(`DROP POLICY ${q(p.policyname)} ON public.${q(p.tablename)};`);
    const wrapped = {
      ...p,
      qual: p.qual ? tsWrap(p.qual) : null,
      with_check: p.with_check ? tsWrap(p.with_check) : null,
    };
    await db.exec(createPolicySql(wrapped));
  }
  const m = await policyMap(db);
  await db.close();
  const oracle = new Map<string, { qual: string | null; with_check: string | null }>();
  for (const p of TARGETS) {
    const key = `${p.tablename}|${p.policyname}`;
    const row = m.get(key);
    if (!row) throw new Error(`oracle build failed: ${key}`);
    oracle.set(key, { qual: row.qual, with_check: row.with_check });
  }
  return oracle;
}

function compareToOracle(
  after: Map<string, PolicyRow>,
  oracle: Map<string, { qual: string | null; with_check: string | null }>,
): string[] {
  const diffs: string[] = [];
  for (const [key, exp] of oracle) {
    const now = after.get(key);
    if (!now || now.qual !== exp.qual || now.with_check !== exp.with_check) diffs.push(key);
  }
  return diffs;
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

  // --- T-check: 생성기 SSOT — committed 출력이 재생성 결과와 byte 일치 (fail-close)
  {
    const r = spawnSync("python3", [join(ROOT, "scripts", "db", "generate-advisor-step2-migration.py"), "--check"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    assert(
      "T-check 생성기 --check: committed forward/rollback 일치",
      r.error === undefined && r.status === 0,
      r.error ? String(r.error) : `${r.status} ${String(r.stdout).slice(0, 200)}`,
    );
  }

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

    // --- A11: target 67/67 qual/with_check 오라클 전건 대조
    const oracle = await buildOracle();
    assert("A11 oracle covers 67 targets", oracle.size === 67, oracle.size);
    const oracleDiffs = compareToOracle(after, oracle);
    assert("A11 post-migration qual/with_check == 독립 wrap 오라클 (67/67)", oracleDiffs.length === 0, oracleDiffs.slice(0, 5));

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

  // --- A7b mutation RED: 테이블 존재 + 대상 policy만 부재 → 거부 (부분 성공 차단)
  {
    const db = await prodLikeDb();
    await db.exec(`DROP POLICY "blocks_select" ON public.user_blocks;`);
    const r = await run(db, migrationSql);
    assert("A7b missing policy (table exists) → EXCEPTION (RED)", !r.ok, "migration must refuse");
    assert("A7b error names missing", /missing while table exists/i.test(r.error), r.error.slice(0, 150));
    await db.close();
  }

  // --- A9 clean-chain: 빈 DB → no-op 성공
  {
    const db = new PGlite();
    const r = await run(db, migrationSql);
    assert("A9 clean-chain (empty db) replay succeeds", r.ok, r.error);
    await db.close();
  }

  // --- A11b/A11c mutation RED: migration 래핑식 오치환 → 오라클 대조가 검출
  {
    const oracle = await buildOracle();
    // blocks_select의 새 USING 식을 특정해 mutant 생성
    const blocksSelect = TARGETS.find((p) => p.tablename === "user_blocks" && p.policyname === "blocks_select")!;
    const wrappedExpr = tsWrap(blocksSelect.qual!);
    const idx = migrationSql.indexOf(wrappedExpr);
    assert("A11 setup: migration contains expected wrapped expr for blocks_select", idx >= 0);

    // A11b: 식을 true로 치환 (fingerprint 가드는 통과하는 오치환 — 오라클만 잡을 수 있다)
    {
      const mutant = migrationSql.replace(wrappedExpr, "true");
      const db = await prodLikeDb();
      const r = await run(db, mutant);
      assert("A11b mutant(true 치환) migration은 가드를 통과해 적용됨", r.ok, r.error);
      const diffs = compareToOracle(await policyMap(db), oracle);
      assert("A11b 오라클 대조가 오치환 검출 (RED)", diffs.includes("user_blocks|blocks_select"), diffs.slice(0, 3));
      await db.close();
    }
    // A11c: 다른 래핑식(auth.uid → auth.role)으로 치환
    {
      const wrongExpr = wrappedExpr.split("auth.uid()").join("auth.role()::uuid");
      const mutant = migrationSql.replace(wrappedExpr, wrongExpr);
      const db = await prodLikeDb();
      const r = await run(db, mutant);
      assert("A11c mutant(오래핑) migration은 가드를 통과해 적용됨", r.ok, r.error);
      const diffs = compareToOracle(await policyMap(db), oracle);
      assert("A11c 오라클 대조가 오래핑 검출 (RED)", diffs.includes("user_blocks|blocks_select"), diffs.slice(0, 3));
      await db.close();
    }
  }

  // --- A10b rollback-drift RED: 적용 후 변조 → rollback 전건 거부
  {
    const db = await prodLikeDb();
    const r1 = await run(db, migrationSql);
    assert("A10b setup: migration applied", r1.ok, r1.error);
    await db.exec(`ALTER POLICY "blocks_select" ON public.user_blocks USING (true);`);
    const rb = await run(db, rollbackSql);
    assert("A10b drifted post-migration state → rollback EXCEPTION (RED)", !rb.ok, "rollback must refuse");
    assert("A10b error names post-migration drift", /not in exact post-migration state/i.test(rb.error), rb.error.slice(0, 150));
    await db.close();
  }

  // --- A10c rollback-missing RED: 적용 후 정책 DROP → rollback 전건 거부
  {
    const db = await prodLikeDb();
    const r1 = await run(db, migrationSql);
    assert("A10c setup: migration applied", r1.ok, r1.error);
    await db.exec(`DROP POLICY "blocks_select" ON public.user_blocks;`);
    const rb = await run(db, rollbackSql);
    assert("A10c missing policy → rollback EXCEPTION (RED)", !rb.ok, "rollback must refuse");
    assert("A10c error names missing", /missing/i.test(rb.error), rb.error.slice(0, 150));
    await db.close();
  }

  // --- A13 rollback-on-baseline RED: migration 미적용 DB에 rollback → 전건 거부
  // (삼순 4차 blocker 1 — 구 unwrap→baseline md5 가드는 이 상태를 통과시켰다)
  {
    const db = await prodLikeDb();
    const rb = await run(db, rollbackSql);
    assert("A13 rollback on un-migrated baseline → EXCEPTION (RED)", !rb.ok, "rollback must refuse baseline state");
    assert("A13 error names exact post-migration state", /not in exact post-migration state/i.test(rb.error), rb.error.slice(0, 150));
    await db.close();
  }

  // --- A13b partial-bare RED: 적용 후 일부 정책만 bare baseline으로 원복 → rollback 거부
  {
    const db = await prodLikeDb();
    const r1 = await run(db, migrationSql);
    assert("A13b setup: migration applied", r1.ok, r1.error);
    const blocksSelect = TARGETS.find((p) => p.tablename === "user_blocks" && p.policyname === "blocks_select")!;
    await db.exec(`ALTER POLICY "blocks_select" ON public.user_blocks USING (${blocksSelect.qual});`);
    const rb = await run(db, rollbackSql);
    assert("A13b partially-bare state → rollback EXCEPTION (RED)", !rb.ok, "rollback must refuse partial-bare");
    assert("A13b error names exact post-migration state", /not in exact post-migration state/i.test(rb.error), rb.error.slice(0, 150));
    await db.close();
  }

  // --- A12 lock-before-read: 구조 판정 + 실효성 실측 (삼순 4차 blocker 2)
  // PGlite는 단일 커넥션이라 동시 DDL 인터리브 재현은 불가하다. 따라서
  //  (a) 순서(lock이 fingerprint SELECT보다 선행)는 구조 판정으로 고정하고
  //  (b) lock 문이 장식이 아님(실제 AccessExclusiveLock 획득)은 tx 내 pg_locks로 실측한다.
  {
    // (a) 구조 판정: DO 본문에서 LOCK EXECUTE가 INTO cur_fp SELECT보다 앞서야 한다
    const lockBeforeRead = (sql: string): boolean => {
      const lockIdx = sql.indexOf("LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE");
      const readIdx = sql.indexOf("INTO cur_fp");
      return lockIdx >= 0 && readIdx >= 0 && lockIdx < readIdx;
    };
    assert("A12 forward: LOCK TABLE이 fingerprint SELECT보다 선행", lockBeforeRead(migrationSql));
    assert("A12 rollback: LOCK TABLE이 fingerprint SELECT보다 선행", lockBeforeRead(rollbackSql));

    // A12b mutation RED: LOCK 라인 제거 mutant → 구조 판정이 검출
    const lockLine = /^.*LOCK TABLE public\.%I IN ACCESS EXCLUSIVE MODE.*\n/m;
    const noLockMutant = migrationSql.replace(lockLine, "");
    assert("A12b mutant(LOCK 제거) → 구조 판정 RED", !lockBeforeRead(noLockMutant));
    // A12c mutation RED: LOCK을 SELECT 뒤로 재배치한 mutant → 구조 판정이 검출
    {
      const lockStmt = migrationSql.match(lockLine)![0];
      const reordered = migrationSql
        .replace(lockLine, "")
        .replace(/^(.*RAISE EXCEPTION 'advisor_step2a: policy fingerprint drift.*)$/m, lockStmt + "$1");
      assert("A12c mutant(LOCK를 read 뒤로) → 구조 판정 RED", !lockBeforeRead(reordered));
    }

    // (b) 실효성: 명시적 tx 안에서 migration 실행 후 pg_locks에 대상 테이블
    // AccessExclusiveLock이 잡혔는지 확인 (DO 블록 커밋 전 시점)
    {
      const db = await prodLikeDb();
      await db.exec("BEGIN;");
      const r = await run(db, migrationSql);
      assert("A12 setup: migration applied inside explicit tx", r.ok, r.error);
      const targetTables = [...new Set(TARGETS.map((p) => p.tablename))];
      const locks = await db.query<{ relname: string }>(`
        SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
        WHERE l.mode = 'AccessExclusiveLock' AND l.granted
      `);
      const held = new Set(locks.rows.map((x) => x.relname));
      const missing = targetTables.filter((t) => !held.has(t));
      assert(`A12 tx 내 pg_locks: 대상 테이블 ${targetTables.length}개 전부 AccessExclusiveLock 보유`, missing.length === 0, missing.slice(0, 5));
      await db.exec("ROLLBACK;");
      await db.close();
    }
  }

  console.log(failed === 0 ? "\nAll advisor-step2 RLS gate tests PASSED" : `\n${failed} test(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
