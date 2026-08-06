#!/usr/bin/env node
/**
 * 야잘알봇 답변 피드백 — **실제 DB 검증** (삼순 NO-GO ①④).
 *
 * SQL 파일을 읽는 것만으로는 "fresh migrated DB 에서 service_role 이 정말 실행 가능한가",
 * "같은 키 동시 호출이 정말 직렬화되는가"를 증명할 수 없다. 임시 스키마에 migration 을
 * 그대로 적용하고 실제 RPC 를 호출한다.
 *
 * 필요: SUPABASE_MANAGEMENT_TOKEN (Management API 로 임의 SQL 실행)
 * 없으면 SKIP 이 아니라 **실패**한다 — 검증 불가를 통과로 위장하지 않는다(fail-close).
 */
import { readFileSync } from "node:fs";

const R = (p) => new URL(`../../${p}`, import.meta.url).pathname;

function loadEnv() {
  const out = {};
  for (const f of [
    R(".env.local"),
    `${process.env.HOME}/Projects/kbo-everyday/.env.local`,
    `${process.env.HOME}/.openclaw/workspace/.env`,
  ]) {
    try {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !out[m[1]]) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {}
  }
  return out;
}

const env = loadEnv();
const TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN || env.SUPABASE_MANAGEMENT_TOKEN;
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
if (!TOKEN || !URL_) {
  console.error("❌ SUPABASE_MANAGEMENT_TOKEN / NEXT_PUBLIC_SUPABASE_URL 없음 — 검증 불가(fail-close)");
  process.exit(1);
}
const REF = URL_.replace(/^https:\/\/([^.]+)\..*$/, "$1");

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL failed: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const SCHEMA = `qa_feedback_${Date.now()}`;
const fails = [];
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  PASS ${name}`);
  else { console.log(`  FAIL ${name} ${detail}`); fails.push(name); }
};

const migration = readFileSync(
  R("supabase/migrations/20260806150000_baseball_genius_answer_feedback.sql"),
  "utf8",
);

try {
  // ── fresh 스키마에 migration 적용 ─────────────────────────────────────────
  // public 을 건드리지 않는다. 임시 스키마에 최소 의존(dm_messages)만 세우고 적용한다.
  await sql(`
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.dm_messages (id bigint PRIMARY KEY);
    CREATE TABLE ${SCHEMA}.genius_question_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, created_at timestamptz DEFAULT now()
    );
  `);

  // migration 의 public. 참조를 임시 스키마로 치환해 그대로 적용한다(내용 변경 없음).
  const scoped = migration
    .replace(/public\./g, `${SCHEMA}.`)
    .replace(/SET search_path = public/g, `SET search_path = ${SCHEMA}`)
    .replace(/ON FUNCTION public/g, `ON FUNCTION ${SCHEMA}`);
  await sql(scoped);
  console.log(`✅ fresh migrate 적용 (${SCHEMA})`);

  // ── ① ACL: service_role 이 EXECUTE 를 실제로 갖는가 ────────────────────────
  const acl = await sql(`
    SELECT has_function_privilege('service_role',
      p.oid, 'EXECUTE') AS can_exec
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='${SCHEMA}' AND p.proname='set_baseball_genius_answer_feedback';
  `);
  ok("① service_role EXECUTE 보유", acl[0]?.can_exec === true, JSON.stringify(acl));

  const tblAcl = await sql(`
    SELECT has_table_privilege('service_role','${SCHEMA}.genius_answer_feedback','INSERT') AS ins,
           has_table_privilege('anon','${SCHEMA}.genius_answer_feedback','SELECT') AS anon_sel,
           has_table_privilege('authenticated','${SCHEMA}.genius_answer_feedback','SELECT') AS auth_sel;
  `);
  ok("① service_role INSERT 보유", tblAcl[0]?.ins === true);
  ok("① anon 차단", tblAcl[0]?.anon_sel === false);
  ok("① authenticated 차단", tblAcl[0]?.auth_sel === false);

  // ── actual RPC: 토글 3단계가 실제로 동작하는가 ────────────────────────────
  const U = "11111111-1111-4111-8111-111111111111";
  await sql(`INSERT INTO ${SCHEMA}.dm_messages(id) VALUES (901),(902);`);

  const r1 = await sql(`SELECT ${SCHEMA}.set_baseball_genius_answer_feedback('${U}'::uuid, 901, 900, 'llm', 'answer', 1::smallint) AS r;`);
  ok("actual: 최초 👍 → 1", Number(r1[0]?.r) === 1, JSON.stringify(r1));

  const r2 = await sql(`SELECT ${SCHEMA}.set_baseball_genius_answer_feedback('${U}'::uuid, 901, 900, 'llm', 'answer', -1::smallint) AS r;`);
  ok("actual: 👍→👎 변경 → -1", Number(r2[0]?.r) === -1, JSON.stringify(r2));

  const r3 = await sql(`SELECT ${SCHEMA}.set_baseball_genius_answer_feedback('${U}'::uuid, 901, 900, 'llm', 'answer', -1::smallint) AS r;`);
  ok("actual: 같은 값 재클릭 → 취소(NULL)", r3[0]?.r === null, JSON.stringify(r3));

  const cnt = await sql(`SELECT count(*)::int AS n FROM ${SCHEMA}.genius_answer_feedback WHERE user_id='${U}' AND answer_message_id=901;`);
  ok("actual: 취소 후 행 0 (중복 row 없음)", cnt[0]?.n === 0, JSON.stringify(cnt));

  // reply_kind 저장 확인 (② 후분석 분리 근거)
  await sql(`SELECT ${SCHEMA}.set_baseball_genius_answer_feedback('${U}'::uuid, 902, 900, 'blocked', 'unavailable', -1::smallint);`);
  const rk = await sql(`SELECT reply_kind, match_path FROM ${SCHEMA}.genius_answer_feedback WHERE answer_message_id=902;`);
  ok("② reply_kind 저장됨", rk[0]?.reply_kind === "unavailable", JSON.stringify(rk));

  // ── ④ 동시성: 같은 키 병렬 호출이 직렬화되는가 ────────────────────────────
  // 같은 (user, answer) 로 👍 를 8번 동시에 던진다. 직렬화되면 토글이 순차 적용되어
  // 최종 행 수는 0 또는 1이고, unique 위반이나 중복 행이 절대 나오면 안 된다.
  const N = 8;
  const results = await Promise.allSettled(
    Array.from({ length: N }, () =>
      sql(`SELECT ${SCHEMA}.set_baseball_genius_answer_feedback('${U}'::uuid, 901, 900, 'llm', 'answer', 1::smallint) AS r;`),
    ),
  );
  const rejected = results.filter((r) => r.status === "rejected");
  ok("④ 병렬 8회 전부 성공(경합 예외 없음)", rejected.length === 0,
     rejected.map((r) => String(r.reason).slice(0, 120)).join(" | "));

  const dup = await sql(`
    SELECT count(*)::int AS rows FROM ${SCHEMA}.genius_answer_feedback
    WHERE user_id='${U}' AND answer_message_id=901;
  `);
  ok("④ 병렬 후에도 행 ≤1 (중복 row 0)", (dup[0]?.rows ?? 99) <= 1, JSON.stringify(dup));

  // rating 은 1 또는 없음 — 중간값이 남으면 안 된다
  const val = await sql(`SELECT rating FROM ${SCHEMA}.genius_answer_feedback WHERE user_id='${U}' AND answer_message_id=901;`);
  ok("④ 최종 상태가 유효값", val.length === 0 || Number(val[0].rating) === 1, JSON.stringify(val));

  // ── invalid rating 은 거부되는가 ──────────────────────────────────────────
  let raised = false;
  try {
    await sql(`SELECT ${SCHEMA}.set_baseball_genius_answer_feedback('${U}'::uuid, 901, 900, 'llm', 'answer', 0::smallint);`);
  } catch { raised = true; }
  ok("rating=0 거부", raised);
} finally {
  try { await sql(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;`); console.log(`🧹 ${SCHEMA} 정리`); }
  catch (e) { console.error("⚠️ 정리 실패:", e.message); }
}

if (fails.length) {
  console.error(`❌ genius-feedback-db-actual FAILED (${fails.length}): ${fails.join(", ")}`);
  process.exit(1);
}
console.log("✅ genius-feedback-db-actual PASS (ACL + actual RPC + concurrency)");
