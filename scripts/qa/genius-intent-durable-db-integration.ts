/**
 * 의도 라우팅 durable 저장 — **실 migration × 실 PostgreSQL(PGlite 17) actual**.
 *
 * ## 왜 이 파일이 필요한가 (삼순 NO-GO 2026-09-01)
 *
 * `genius-intent-durable-contract.ts` 는 in-memory `makeStore` 로 계약을 잰다. 그건
 * **정답을 복제한 사본**이라, 실제 `server.ts` 의 SELECT/UPDATE/CAS 조건이 깨져도
 * RED 가 되지 않는다. 그런데 이 PR 이 고친 결함들은 전부 **그 쿼리 모양**에 있었다:
 *
 *   · `.is("intent_verdict", null)` 이 fingerprint 교체를 영원히 막던 것
 *   · provenance 를 판정과 **다른 UPDATE** 로 쓰면 "판정은 있는데 provenance 만 없는" 행
 *   · CAS 패자가 winner 를 안 읽어 두 worker 가 다른 답을 내보내던 것
 *
 * 그래서 여기서는 **production 함수 `createIntentDurableAdapters` 를 그대로** PGlite 에
 * 물려 돌린다. client 만 갈아끼울 뿐 함수는 배포되는 그것이다(seam 동일성, M90).
 * 외부 자격증명이 필요 없으므로 CI 에서 항상 돈다.
 *
 * ## 축
 *
 *   D1  최초 저장 = winner(null 반환) · 컬럼이 실제로 채워진다
 *   D2  같은 fingerprint 재저장 = CAS 패자 → **winner 행을 읽어 돌려준다**
 *   D3  fingerprint 교체 시 새 판정이 저장된다 (`.is(null)` 회귀 방어)
 *   D4  provenance 가 판정과 **같은 UPDATE** 로 실린다 — verdict 있고 known NULL 인 행 0
 *   D5  구 행(known NULL)은 재생에서 false 로 접힌다
 *   D6  render CAS — winner 문구 1회 고정, 패자는 그 문구를 받는다
 *   D7  normalize snapshot — 최초 1회 고정 + CAS 패자가 winner snapshot 을 받는다
 *   D8  컬럼 부재(42703)를 기능 장애로 만들지 않는다 (migration 선행 배포 창)
 *
 * ## 결함주입 (`--mutate=<name>`)
 *
 *   is-null-cas        D3 RED — CAS 조건을 `.is(verdict, null)` 로 되돌린다
 *   split-provenance   D4 RED — provenance 를 별도 UPDATE 로 분리
 *   loser-keeps-own    D2 RED — 패자가 winner 를 안 읽고 null 반환
 *   render-overwrite   D6 RED — render 가 매번 덮어쓴다
 *
 * ⚠️ mutation 은 **어댑터가 실행하는 SQL 을 하위 client 층에서 변형**한다. 앱 코드에
 *   QA 분기를 넣지 않는다(2026-08-22 M90).
 *
 * 실행: npm run qa:genius-intent-durable-db
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://intent-durable-test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : dflt;
}
const MUTATE = arg("mutate", "");
const SELFTEST = process.argv.includes("--selftest");
const MUTATIONS = ["is-null-cas", "split-provenance", "loser-keeps-own", "render-overwrite"] as const;
type Mutation = (typeof MUTATIONS)[number];
const EXPECTED_RED: Record<Mutation, string[]> = {
  "is-null-cas": ["D3"],
  "split-provenance": ["D4"],
  "loser-keeps-own": ["D2"],
  "render-overwrite": ["D6"],
};

let pass = 0;
const failed: string[] = [];
function check(id: string, name: string, ok: boolean, extra?: unknown) {
  if (ok) { pass += 1; return; }
  failed.push(id);
  console.log(`FAIL ${id} ${name}${extra === undefined ? "" : ` :: ${JSON.stringify(extra)}`}`);
}

/**
 * migration 을 **내용으로** 찾는다 — 파일명을 하드코딩하면 이름이 바뀌었을 때 게이트가
 * 조용히 다른 파일을 읽거나 통과한다.
 */
function findMigration(marker: RegExp): string {
  const dir = resolve("supabase/migrations");
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(resolve(dir, f), "utf8"))
    .filter((src) => marker.test(src));
  if (hits.length !== 1) {
    throw new Error(`migration 탐색 실패: ${marker} 매치 ${hits.length}개 (1개여야 한다)`);
  }
  return hits[0]!;
}

// ── supabase-js → PGlite 어댑터 ──────────────────────────────────────────────
// 어댑터가 실제로 쓰는 빌더 모양만 지원한다:
//   .from(t).select(c).eq(c,v).maybeSingle()
//   .from(t).update(o).eq(c,v).is(c,null).or(expr).select(c)
type Row = Record<string, unknown>;
interface Cond { sql: string; params: unknown[] }

function makeBuilder(db: PGlite, table: string, opts: { dropColumns?: boolean }) {
  let mode: "select" | "update" = "select";
  let selectCols = "*";
  let updateObj: Row = {};
  const conds: Cond[] = [];
  let single = false;

  function whereSql(params: unknown[]): string {
    const parts: string[] = [];
    for (const c of conds) {
      let sql = c.sql;
      for (const p of c.params) { params.push(p); sql = sql.replace("??", `$${params.length}`); }
      parts.push(`(${sql})`);
    }
    return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
  }

  async function run(): Promise<{ data: unknown; error: { code?: string; message: string } | null }> {
    // migration 미적용 창 재현 — PostgREST 는 42703 을 준다.
    if (opts.dropColumns) {
      return { data: null, error: { code: "42703", message: 'column "intent_verdict" does not exist' } };
    }
    const params: unknown[] = [];
    try {
      let sql: string;
      if (mode === "update") {
        const sets = Object.keys(updateObj).map((k) => {
          params.push(updateObj[k]); return `${k} = $${params.length}`;
        });
        sql = `UPDATE ${table} SET ${sets.join(", ")}${whereSql(params)} RETURNING ${selectCols}`;
      } else {
        sql = `SELECT ${selectCols} FROM ${table}${whereSql(params)}`;
      }
      const r = await db.query<Row>(sql, params);
      const rows = r.rows ?? [];
      if (single) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  }

  const b: Record<string, unknown> = {
    select(c?: string) { selectCols = c?.trim() || "*"; return b; },
    update(o: Row) { mode = "update"; updateObj = { ...o }; return b; },
    eq(c: string, v: unknown) { conds.push({ sql: `${c} = ??`, params: [v] }); return b; },
    is(c: string, v: unknown) {
      if (v === null) conds.push({ sql: `${c} IS NULL`, params: [] });
      else conds.push({ sql: `${c} = ??`, params: [v] });
      return b;
    },
    // PostgREST `.or("a.is.null,b.neq.X")` → SQL OR 로 번역한다.
    or(expr: string) {
      const parts = expr.split(",").map((raw) => {
        const [col, op, ...rest] = raw.split(".");
        const val = rest.join(".");
        if (op === "is" && val === "null") return { sql: `${col} IS NULL`, params: [] as unknown[] };
        if (op === "neq") return { sql: `(${col} IS DISTINCT FROM ??)`, params: [val] };
        if (op === "eq") return { sql: `${col} = ??`, params: [val] };
        throw new Error(`지원하지 않는 or 연산: ${raw}`);
      });
      conds.push({
        sql: parts.map((p) => p.sql).join(" OR "),
        params: parts.flatMap((p) => p.params),
      });
      return b;
    },
    maybeSingle() { single = true; return run(); },
    then(f: (v: unknown) => unknown, r?: (e: unknown) => unknown) { return run().then(f, r); },
  };
  return b;
}

function makeClient(db: PGlite, opts: { dropColumns?: boolean } = {}) {
  return { from: (table: string) => makeBuilder(db, table, opts) } as never;
}

const FP = "fp-aaa";
const FP2 = "fp-bbb";
const MSG = 4242;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create table public.genius_question_jobs (
      message_id bigint primary key,
      user_id uuid not null,
      status text not null default 'queued',
      updated_at timestamptz not null default now()
    );
  `);
  // 실 migration 을 그대로 적용한다 — 컬럼 정의를 게이트가 재구현하면 결함을 못 본다.
  await db.exec(findMigration(/ADD COLUMN IF NOT EXISTS intent_verdict_known boolean/));
  await db.exec(
    `insert into public.genius_question_jobs (message_id, user_id)
     values (${MSG}, '11111111-1111-4111-8111-111111111111')`,
  );
  return db;
}

async function main() {
  console.log(`[intent-durable-db] PGlite 17 · mutate=${MUTATE || "none"}\n`);
  const { createIntentDurableAdapters } = await import("../../src/lib/baseball-qa/server");

  type Adapters = ReturnType<typeof createIntentDurableAdapters>;
  /** production 함수를 PGlite 클라이언트로 태운다. mutation 은 여기서만 덧씌운다. */
  function adapters(db: PGlite, opts: { dropColumns?: boolean } = {}): Adapters {
    const client = makeClient(db, opts);
    const a = createIntentDurableAdapters(client, MSG);
    if (MUTATE === "is-null-cas") {
      // 회귀 재현: CAS 조건을 fingerprint 무관 `.is(verdict, null)` 로 되돌린다.
      return {
        ...a,
        storeIntentDecision: async (d) => {
          const { data } = await (client as unknown as {
            from: (t: string) => Record<string, (...x: unknown[]) => unknown>;
          }).from("genius_question_jobs")
            .update({
              intent_verdict: d.verdict, intent_fingerprint: d.fingerprint,
              intent_answer: d.answer, intent_clarify: d.clarify, intent_team: d.team,
              intent_verdict_known: d.verdictKnown,
              updated_at: new Date().toISOString(),
            } as never)
            .eq("message_id", MSG)
            .is("intent_verdict", null)
            .select("intent_verdict") as Promise<{ data: unknown[] | null }>;
          return (data?.length ?? 0) > 0 ? null : (await a.getIntentDecision());
        },
      };
    }
    if (MUTATE === "split-provenance") {
      // 회귀 재현: provenance 를 판정과 다른 UPDATE 로 분리한다(그리고 그 두 번째를 빠뜨린다).
      return {
        ...a,
        storeIntentDecision: async (d) => a.storeIntentDecision({ ...d, verdictKnown: null }),
      };
    }
    if (MUTATE === "loser-keeps-own") {
      // 회귀 재현: 패자가 winner 를 읽지 않고 자기 판정을 쓴다.
      return {
        ...a,
        storeIntentDecision: async (d) => { await a.storeIntentDecision(d); return null; },
      };
    }
    if (MUTATE === "render-overwrite") {
      // 회귀 재현: render 가 조건 없이 덮어쓴다.
      return {
        ...a,
        storeIntentRender: async (_fp, rendered) => {
          await (client as unknown as {
            from: (t: string) => Record<string, (...x: unknown[]) => unknown>;
          }).from("genius_question_jobs")
            .update({ intent_answer: rendered } as never)
            .eq("message_id", MSG)
            .select("intent_answer");
          return null;
        },
      };
    }
    return a;
  }

  const decision = (over: Partial<{
    verdict: string; fingerprint: string; answer: string | null;
    clarify: string | null; team: string | null; verdictKnown: boolean | null;
  }> = {}) => ({
    verdict: "NEEDS_CLARIFICATION", fingerprint: FP, answer: null,
    clarify: "game", team: null, verdictKnown: true, ...over,
  });

  // ── D1 최초 저장 = winner, 컬럼 실제 반영 ────────────────────────────────
  {
    const db = await freshDb();
    const a = adapters(db);
    const r = await a.storeIntentDecision(decision());
    const row = (await db.query<Row>(
      `select intent_verdict, intent_fingerprint, intent_clarify, intent_verdict_known
       from public.genius_question_jobs where message_id = ${MSG}`,
    )).rows[0]!;
    check("D1", "최초 저장은 winner(null) 이고 컬럼이 실제로 채워진다",
      r === null && row.intent_verdict === "NEEDS_CLARIFICATION"
        && row.intent_fingerprint === FP && row.intent_clarify === "game",
      { returned: r, row });
  }

  // ── D2 같은 fingerprint 재저장 = CAS 패자 → winner 를 돌려받는다 ──────────
  {
    const db = await freshDb();
    const a = adapters(db);
    await a.storeIntentDecision(decision({ verdict: "NEEDS_CLARIFICATION" }));
    // 다른 worker 가 **다른 판정**으로 쓰려 한다.
    const loser = await a.storeIntentDecision(decision({ verdict: "SMALLTALK_SCOPE", clarify: null }));
    check("D2", "같은 fingerprint 재저장은 CAS 패자 — winner 판정을 돌려받는다",
      loser !== null && loser.verdict === "NEEDS_CLARIFICATION",
      { loser });
  }

  // ── D3 fingerprint 교체 시 새 판정이 저장된다 (`.is(null)` 회귀 방어) ─────
  {
    const db = await freshDb();
    const a = adapters(db);
    await a.storeIntentDecision(decision({ fingerprint: FP }));
    await a.storeIntentDecision(decision({ fingerprint: FP2, verdict: "FOLLOWUP", clarify: null }));
    const row = (await db.query<Row>(
      `select intent_verdict, intent_fingerprint from public.genius_question_jobs where message_id = ${MSG}`,
    )).rows[0]!;
    check("D3", "fingerprint 가 바뀌면 새 판정이 저장된다(옛 판정이 영원히 남지 않는다)",
      row.intent_fingerprint === FP2 && row.intent_verdict === "FOLLOWUP", row);
  }

  // ── D4 provenance 가 판정과 같은 UPDATE 에 실린다 ────────────────────────
  {
    const db = await freshDb();
    const a = adapters(db);
    await a.storeIntentDecision(decision({ verdictKnown: false }));
    // 계약: "판정은 있는데 provenance 만 NULL" 인 행이 **구조적으로 불가능**해야 한다.
    const orphan = (await db.query<{ n: number }>(
      `select count(*)::int as n from public.genius_question_jobs
       where intent_verdict is not null and intent_verdict_known is null`,
    )).rows[0]!.n;
    const got = await a.getIntentDecision();
    check("D4", "provenance 가 판정과 같은 UPDATE 로 실린다(고아 행 0)",
      Number(orphan) === 0 && got?.verdictKnown === false,
      { orphan, verdictKnown: got?.verdictKnown });
  }

  // ── D5 구 행(known NULL)은 재생에서 false 로 접힌다 ──────────────────────
  {
    const db = await freshDb();
    // migration 이전에 저장된 행을 직접 만든다(컬럼만 있고 값이 NULL).
    await db.exec(
      `update public.genius_question_jobs
       set intent_verdict = 'BASEBALL', intent_fingerprint = '${FP}'
       where message_id = ${MSG}`,
    );
    const got = await adapters(db).getIntentDecision();
    check("D5", "구 행(provenance NULL)은 판정 없음으로 접힌다",
      got !== null && got.verdict === "BASEBALL" && got.verdictKnown === null, got);
  }

  // ── D6 render CAS — winner 문구 1회 고정, 패자는 그 문구를 받는다 ────────
  {
    const db = await freshDb();
    const a = adapters(db);
    await a.storeIntentDecision(decision());
    const first = await a.storeIntentRender(FP, "오늘 경기는 LG:KIA 입니다");
    const second = await a.storeIntentRender(FP, "오늘 경기가 없습니다");
    const row = (await db.query<Row>(
      `select intent_answer from public.genius_question_jobs where message_id = ${MSG}`,
    )).rows[0]!;
    check("D6", "render 는 최초 문구로 고정되고 패자는 그 문구를 받는다",
      first === null && second === "오늘 경기는 LG:KIA 입니다"
        && row.intent_answer === "오늘 경기는 LG:KIA 입니다",
      { first, second, row });
  }

  // ── D7 normalize snapshot — 최초 고정 + CAS 패자 ─────────────────────────
  {
    const db = await freshDb();
    const a = adapters(db);
    const w = await a.storeNormalizeSnapshot({
      originalQuestion: "보끄가모야", status: "accepted_surface",
      acceptedText: "보크가 뭐야", suggestionText: null,
    });
    const l = await a.storeNormalizeSnapshot({
      originalQuestion: "보끄가모야", status: "rejected",
      acceptedText: null, suggestionText: null,
    });
    const got = await a.getNormalizeSnapshot();
    check("D7", "정규화 snapshot 은 최초 1회 고정 · 패자는 winner 를 받는다",
      w === null && l !== null && l.status === "accepted_surface"
        && got?.acceptedText === "보크가 뭐야",
      { winner: w, loser: l, got });
  }

  // ── D8 컬럼 부재(42703)를 기능 장애로 만들지 않는다 ──────────────────────
  {
    const db = await freshDb();
    const a = adapters(db, { dropColumns: true });
    const got = await a.getIntentDecision();
    const stored = await a.storeIntentDecision(decision());
    const snap = await a.getNormalizeSnapshot();
    check("D8", "migration 선행 배포 창(42703)에서 throw 하지 않고 판정없음으로 접는다",
      got === null && stored === null && snap === null,
      { got, stored, snap });
  }

  console.log(`\n=== ${pass} PASS / ${failed.length} FAIL ===`);
  if (failed.length) console.log(failed.join(", "));
  return failed;
}

function selftest(): number {
  let bad = 0;
  for (const m of MUTATIONS) {
    const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1], `--mutate=${m}`],
      { encoding: "utf8", env: process.env });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const reds = [...out.matchAll(/^FAIL (D\d+) /gm)].map((x) => x[1]);
    const want = EXPECTED_RED[m];
    const missing = want.filter((id) => !reds.includes(id));
    const extra = reds.filter((id) => !want.includes(id));
    const ok = missing.length === 0 && extra.length === 0 && r.status !== 0;
    console.log(`${ok ? "OK  " : "BAD "} mutate=${m.padEnd(18)} red=[${reds.join(",")}] want=[${want.join(",")}]`);
    if (!ok) {
      bad += 1;
      if (missing.length) console.log(`     누락 RED: ${missing.join(",")}`);
      if (extra.length) console.log(`     기대 밖 RED: ${extra.join(",")}`);
      if (r.status === 0) console.log("     exit=0 — 결함을 주입했는데 통과했다");
    }
  }
  console.log(`\n=== selftest ${MUTATIONS.length - bad}/${MUTATIONS.length} ===`);
  return bad;
}

if (SELFTEST) {
  process.exit(selftest() === 0 ? 0 : 1);
} else {
  main().then((f) => process.exit(f.length === 0 ? 0 : 1)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
