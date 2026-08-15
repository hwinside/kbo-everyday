// btree_gist 설치 위치 게이트 (삼순 #1202 P1 — repo↔Production drift 봉합 검증).
//
// 검증 계약:
//   1. 정본화 migration(20260815184000)은 어떤 시작 상태에서든 btree_gist 를
//      `extensions` 스키마로 수렴시킨다 — 미설치 / public 설치 / 이미 extensions.
//   2. 재실행해도 안전하다(멱등).
//   3. repo 의 migration 정본에 "public 에 btree_gist 를 새로 설치"하는 문장이
//      정본화 migration 이후로 다시 생기지 않는다(파일 검사 — drift 재발 방지).
//
// 실행: npm run qa:btree-gist-schema  (PGlite 실 DB 종단 — synthetic regex 재구현 아님)
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import fs from "node:fs";
import path from "node:path";

const CANON_MIGRATION = "supabase/migrations/20260815184000_btree_gist_extensions_schema.sql";
const LEDGER_MIGRATION = "supabase/migrations/20260815173000_baseball_genius_motion_cooldown_ledger.sql";

let failures = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) console.log(`  ✅ ${name}`);
  else {
    failures += 1;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const gistSchema = async (db: PGlite): Promise<string | null> => {
  const result = await db.query<{ nspname: string }>(
    `select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
     where e.extname = 'btree_gist'`,
  );
  return result.rows[0]?.nspname ?? null;
};

const canonSql = fs.readFileSync(CANON_MIGRATION, "utf8");

const run = async () => {
  // ── ① 미설치 → extensions 에 설치 ────────────────────────────────────────────
  {
    const db = new PGlite({ extensions: { btree_gist } });
    await db.exec(canonSql);
    check("① 미설치 상태에서 실행 → extensions 에 설치", (await gistSchema(db)) === "extensions");
    await db.exec(canonSql);
    check("① 재실행(멱등) → extensions 유지", (await gistSchema(db)) === "extensions");
    await db.close();
  }

  // ── ② public 설치(drift 재현) → extensions 로 이동 ──────────────────────────
  {
    const db = new PGlite({ extensions: { btree_gist } });
    await db.exec("create extension btree_gist"); // 구 migration 의 public 설치 재현
    check("② 시작 상태 = public 설치(drift 재현)", (await gistSchema(db)) === "public");
    await db.exec(canonSql);
    check("② 실행 → extensions 로 이동", (await gistSchema(db)) === "extensions");
    // 이동 후에도 gist opclass 참조(EXCLUDE 제약)가 살아 있는지 — 원장 migration 전체 적재.
    // (원장의 FK 대상 dm_messages 는 이 게이트 관심사가 아니므로 최소 스텁만 둔다.)
    await db.exec("create table public.dm_messages (id bigint primary key)");
    await db.exec("create role service_role; create role anon; create role authenticated");
    await db.exec("set search_path = public, extensions");
    await db.exec(fs.readFileSync(LEDGER_MIGRATION, "utf8"));
    const excl = await db.query<{ count: number }>(
      "select count(*)::int as count from pg_constraint where conname = 'genius_motion_grants_cooldown_excl'",
    );
    check("② 이동 후에도 EXCLUDE 제약 생성 가능(opclass 참조 무결)", excl.rows[0]?.count === 1);
    await db.close();
  }

  // ── ③ 이미 extensions → no-op ───────────────────────────────────────────────
  {
    const db = new PGlite({ extensions: { btree_gist } });
    await db.exec("create schema extensions; create extension btree_gist with schema extensions");
    await db.exec(canonSql);
    check("③ 이미 extensions 상태에서 실행 → no-op 유지", (await gistSchema(db)) === "extensions");
    await db.close();
  }

  // ── ④ repo 정본 drift 재발 방지 (파일 검사) ─────────────────────────────────
  //   정본화 migration 이후 timestamp 의 migration 이 btree_gist 를 스키마 지정 없이
  //   설치하면 새 환경에서 public 설치가 부활한다. WITH SCHEMA extensions 만 허용.
  {
    const dir = "supabase/migrations";
    const canonStamp = path.basename(CANON_MIGRATION).slice(0, 14);
    const offenders: string[] = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (file.slice(0, 14) <= canonStamp) continue; // 정본화 이전 이력은 히스토리로 보존
      const body = fs.readFileSync(path.join(dir, file), "utf8").toLowerCase();
      const installs = body.match(/create\s+extension[^;]*btree_gist[^;]*/g) ?? [];
      for (const stmt of installs) {
        if (!stmt.includes("with schema extensions")) offenders.push(`${file}: ${stmt.slice(0, 80)}`);
      }
    }
    check("④ 정본화 이후 migration 에 public btree_gist 설치 재발 없음", offenders.length === 0,
      offenders.join(" | "));
  }

  if (failures > 0) {
    console.error(`❌ btree-gist schema gate FAIL: ${failures}건`);
    process.exit(1);
  }
  console.log("✅ btree-gist schema gate: 전 축 PASS (미설치 설치·public 이동·멱등·EXCLUDE 무결·재발 방지)");
};

run().catch((error) => {
  console.error("❌ btree-gist schema gate FAIL:", error);
  process.exit(1);
});
