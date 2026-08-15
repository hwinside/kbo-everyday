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

  // ── ② 실제 순서 재현: 원장(173000) 적재 → public+EXCLUDE → 정본화(184000) 이동 ──
  //   실제 이력은 173000 이 public 에 btree_gist 를 설치하고 EXCLUDE 까지 만든 **뒤에**
  //   184000 이 확장을 extensions 로 옮긴다. 게이트도 같은 순서로 태워, 의존 EXCLUDE 가
  //   이미 존재하는 상태에서 이동해도 제약이 존속하고 중첩 INSERT 를 계속 차단하는지 증명한다.
  {
    const db = new PGlite({ extensions: { btree_gist } });
    // 원장 migration 의 FK 대상·롤 최소 스텁 (게이트 관심사 아님)
    await db.exec("create table public.dm_messages (id bigint primary key)");
    await db.exec("create role service_role; create role anon; create role authenticated");
    await db.exec("set search_path = public, extensions");
    // 1) 원장 migration 적재 — 구 정본 그대로 public 설치 + EXCLUDE 생성
    await db.exec(fs.readFileSync(LEDGER_MIGRATION, "utf8"));
    check("② 원장 적재 후 시작 상태 = public 설치(drift 재현)", (await gistSchema(db)) === "public");
    const exclBefore = await db.query<{ count: number }>(
      "select count(*)::int as count from pg_constraint where conname = 'genius_motion_grants_cooldown_excl'",
    );
    check("② 이동 전 EXCLUDE 제약 존재", exclBefore.rows[0]?.count === 1);
    // 2) 정본화 migration 실행 — 의존 EXCLUDE 가 있는 상태에서 확장 이동
    await db.exec(canonSql);
    check("② 정본화 실행 → extensions 로 이동", (await gistSchema(db)) === "extensions");
    const exclAfter = await db.query<{ count: number }>(
      "select count(*)::int as count from pg_constraint where conname = 'genius_motion_grants_cooldown_excl'",
    );
    check("② 이동 후 EXCLUDE 제약 존속", exclAfter.rows[0]?.count === 1);
    // 3) 이동 후에도 제약이 **동작**하는지 — 중첩 granted INSERT 차단 / 정확히 30초는 허용
    await db.exec("insert into public.dm_messages (id) values (1), (2), (3)");
    const T0 = "2026-08-15T12:00:00Z";
    const T0_10S = "2026-08-15T12:00:10Z"; // |Δ| < 30초 → 겹침
    const T0_30S = "2026-08-15T12:00:30Z"; // |Δ| = 30초 → 반열림 경계, 허용
    const uid = "00000000-0000-0000-0000-000000000001";
    const ins = (id: number, at: string) =>
      db.query(
        `insert into public.genius_motion_grants
           (message_id, user_id, motion, granted, decided_at, cooldown_until)
         values ($1, $2, 'excited', true, $3::timestamptz, $3::timestamptz + interval '30 seconds')`,
        [id, uid, at],
      );
    await ins(1, T0);
    let overlapBlocked = false;
    try {
      await ins(2, T0_10S);
    } catch (error) {
      overlapBlocked = String(error).includes("genius_motion_grants_cooldown_excl");
    }
    check("② 이동 후 중첩 granted INSERT 차단(제약 실동작)", overlapBlocked);
    let boundaryAllowed = true;
    try {
      await ins(3, T0_30S);
    } catch {
      boundaryAllowed = false;
    }
    check("② 정확히 30초 경계 INSERT 허용(반열림 구간)", boundaryAllowed);
    // 4) 정본화 재실행(멱등) — 이동 완료 상태에서 no-op
    await db.exec(canonSql);
    check("② 정본화 재실행(멱등) → extensions 유지", (await gistSchema(db)) === "extensions");
    const exclFinal = await db.query<{ count: number }>(
      "select count(*)::int as count from pg_constraint where conname = 'genius_motion_grants_cooldown_excl'",
    );
    check("② 재실행 후에도 EXCLUDE 제약 존속", exclFinal.rows[0]?.count === 1);
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
