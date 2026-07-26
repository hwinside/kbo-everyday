// 실제 PostgreSQL 통합 회귀 — channel_born self-heal RPC.
//
// 삼순 R1 blocker 게이트: statement_timeout 자기-arm이 불가하므로, concurrent lock이
// 있어도 RPC가 (a) 대기하지 않고 유계 시간에 반환하며 (b) 잠긴 행/회전 중 채널을
// 건너뛰고 (c) 다음 실행에서 수렴함을 *실제 다중 연결 Postgres*로 증명한다.
// migration 문자열 regex가 아니라, 실 migration 파일을 임시 PG17 클러스터에 적용해
// 동시 트랜잭션(FOR UPDATE 보유)과 경합시키며 벽시계 시간을 측정한다.
//
// 실행: node scripts/qa/la-channel-born-reconcile-pg.mjs
//   PG_BINDIR 로 postgres@17 bin 경로 override 가능(기본 brew 경로 자동탐색).

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MIGRATION = "supabase/migrations/20260726_la_channel_born_reconcile.sql";
const PORT = 5000 + Math.floor(Math.random() * 2000);
const HOST = "127.0.0.1";

function findBinDir() {
  if (process.env.PG_BINDIR) return process.env.PG_BINDIR;
  const cands = [
    "/opt/homebrew/opt/postgresql@17/bin",
    "/usr/local/opt/postgresql@17/bin",
    "/opt/homebrew/opt/postgresql/bin",
  ];
  for (const c of cands) if (existsSync(join(c, "initdb"))) return c;
  throw new Error("postgresql@17 bin not found — set PG_BINDIR");
}

const BIN = findBinDir();
// macOS: 로케일이 postmaster를 멀티스레드로 만들어 기동 실패 → C 로케일 고정.
const PG_ENV = { ...process.env, LC_ALL: "C", LANG: "C", PGPASSWORD: "" };
const pgdata = mkdtempSync(join(tmpdir(), "born-pg-"));
let started = false;
let checks = 0;
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  teardown();
  process.exit(1);
};
const check = (name, cond) => {
  if (!cond) fail(name);
  checks += 1;
};

function psql(sql, { timeoutMs = 15000 } = {}) {
  return execFileSync(join(BIN, "psql"), ["-h", HOST, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tAqc", sql], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: PG_ENV,
  }).trim();
}

function teardown() {
  try {
    if (started) execFileSync(join(BIN, "pg_ctl"), ["-D", pgdata, "-m", "immediate", "stop"], { timeout: 15000, stdio: "ignore", env: PG_ENV });
  } catch { /* ignore */ }
  try { rmSync(pgdata, { recursive: true, force: true }); } catch { /* ignore */ }
}

// --- 클러스터 기동 ---
execFileSync(join(BIN, "initdb"), ["-D", pgdata, "-U", "postgres", "--auth=trust", "-N"], { stdio: "ignore", env: PG_ENV });
const proc = spawn(join(BIN, "postgres"), ["-D", pgdata, "-p", String(PORT), "-h", HOST, "-c", "fsync=off", "-c", "full_page_writes=off", "-c", "log_min_messages=panic"], { stdio: "ignore", env: PG_ENV });
proc.unref();
started = true;

// ready 대기
let ready = false;
for (let i = 0; i < 60; i++) {
  try { psql("select 1", { timeoutMs: 2000 }); ready = true; break; } catch { await new Promise((r) => setTimeout(r, 250)); }
}
if (!ready) fail("postgres did not become ready");

try {
  // --- 스키마 (실 컬럼 반영, auth.users FK만 테스트 편의로 생략) ---
  psql(`
    create role service_role;
    grant usage on schema public to service_role;
    create table live_activity_channels (
      game_id text not null, environment text not null, channel_id text not null,
      status text not null default 'active', primary key (game_id, environment));
    create table live_activity_started_users (
      game_id text not null, user_id uuid not null, created_at timestamptz not null default now(),
      channel_born_environment text, channel_born_channel_id text, primary key (game_id, user_id));
    create table live_activity_channel_subscriptions (
      game_id text not null, device_key text not null, environment text not null,
      channel_id text not null, user_id uuid, confirmed_at timestamptz not null default now(),
      primary key (game_id, device_key, environment));
  `);

  // --- 실 migration 함수 적용 ---
  const migSql = readFileSync(MIGRATION, "utf8");
  psql(migSql);
  check("grant is scoped to service_role", psql(`select has_function_privilege('service_role','reconcile_live_activity_channel_born(integer)','execute')`) === "t");

  const uid = (g, n) => `00000000-0000-0000-0000-0000${String(g).replace(/\D/g, "").padStart(4, "0")}${String(n).padStart(4, "0")}`;
  const seedGame = (game, chan, users, { markStale = false } = {}) => {
    psql(`insert into live_activity_channels(game_id,environment,channel_id,status) values ('${game}','production','${chan}','active')`);
    for (const n of users) {
      psql(`insert into live_activity_started_users(game_id,user_id) values ('${game}','${uid(game, n)}')`);
      const ackChan = markStale ? `${chan}_OLD` : chan;
      psql(`insert into live_activity_channel_subscriptions(game_id,device_key,environment,channel_id,user_id) values ('${game}','dev${n}','production','${ackChan}','${uid(game, n)}')`);
    }
  };
  const bornCount = (game) => Number(psql(`select count(*) from live_activity_started_users where game_id='${game}' and channel_born_channel_id is not null`));
  const reconcile = () => {
    const t0 = process.hrtime.bigint();
    const out = psql(`select healed, eligible, has_more from reconcile_live_activity_channel_born(1000)`);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const [healed, eligible, hasMore] = out.split("|");
    return { healed: Number(healed), eligible: Number(eligible), hasMore: hasMore === "t", ms };
  };
  // 세션 A: 지정 SQL로 lock 획득 후 holdMs 동안 트랜잭션 유지(ROLLBACK).
  const holdLock = (lockSql, holdSec) => {
    const child = spawn(join(BIN, "psql"), ["-h", HOST, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `begin; ${lockSql}; select pg_sleep(${holdSec}); rollback;`], { stdio: "ignore", env: PG_ENV });
    return child;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ===== Test 1: 기본 힐 =====
  seedGame("G1", "C1", [1, 2, 3, 4, 5]);
  let r = reconcile();
  check("baseline heals all eligible", r.healed === 5 && r.eligible === 5);
  check("baseline count persisted", bornCount("G1") === 5);
  check("baseline idempotent (no re-heal)", reconcile().healed === 0);

  // ===== Test 2: 이미 마킹된 행 불변 =====
  psql(`insert into live_activity_channels(game_id,environment,channel_id,status) values ('G2','production','C2','active')`);
  psql(`insert into live_activity_started_users(game_id,user_id,channel_born_environment,channel_born_channel_id) values ('G2','${uid("G2", 1)}','production','PRE_EXISTING')`);
  psql(`insert into live_activity_channel_subscriptions(game_id,device_key,environment,channel_id,user_id) values ('G2','d1','production','C2','${uid("G2", 1)}')`);
  r = reconcile();
  check("already-marked row is never overwritten", psql(`select channel_born_channel_id from live_activity_started_users where game_id='G2'`) === "PRE_EXISTING");
  check("already-marked row excluded from healed", r.healed === 0);

  // ===== Test 3: stale ACK(구 채널) 제외 =====
  seedGame("G3", "C3", [1, 2], { markStale: true });
  check("stale-channel ACK is not eligible", reconcile().healed === 0 && bornCount("G3") === 0);

  // ===== Test 4: 대상 행 FOR UPDATE 경합 → 대기 없이 skip, 유계 반환 =====
  seedGame("G4", "C4", [1, 2, 3, 4, 5]);
  const lockRow = holdLock(`select 1 from live_activity_started_users where game_id='G4' and user_id='${uid("G4", 1)}' for update`, 6);
  await sleep(1200); // A가 lock 획득할 시간
  r = reconcile();
  check("locked target does not stall reconcile (<2500ms)", r.ms < 2500);
  check("locked target is skipped, others heal", r.healed === 4);
  check("locked row stays unmarked this tick", psql(`select channel_born_channel_id from live_activity_started_users where game_id='G4' and user_id='${uid("G4", 1)}'`) === "");
  await new Promise((res) => lockRow.on("exit", res)); // A 종료(ROLLBACK) 대기
  check("previously-locked row heals on next tick", reconcile().healed === 1 && bornCount("G4") === 5);

  // ===== Test 5: 2환경 game 중 한 active 채널 회전 → game 전체 skip, 유계 반환 =====
  seedGame("G5", "C5", [1, 2, 3]);
  psql(`insert into live_activity_channels(game_id,environment,channel_id,status) values ('G5','sandbox','C5_SANDBOX','active')`);
  for (const n of [1, 2, 3]) {
    psql(`insert into live_activity_channel_subscriptions(game_id,device_key,environment,channel_id,user_id)
          values ('G5','s${n}','sandbox','C5_SANDBOX','${uid("G5", n)}')`);
  }
  const lockChan = holdLock(`select 1 from live_activity_channels where game_id='G5' and environment='production' for update`, 6);
  await sleep(1200);
  r = reconcile();
  check("rotating channel does not stall reconcile (<2500ms)", r.ms < 2500);
  check("one locked environment skips the whole game (no sandbox fallback)", r.healed === 0 && bornCount("G5") === 0);
  await new Promise((res) => lockChan.on("exit", res));
  r = reconcile();
  check(
    "released game heals on next tick with production-preferred generation",
    r.healed === 3 &&
      bornCount("G5") === 3 &&
      psql(`select count(*) from live_activity_started_users where game_id='G5' and channel_born_environment='production' and channel_born_channel_id='C5'`) === "3",
  );

  // ===== Test 7: batch 경계 starvation — 1,001 eligible 중 정렬상 앞 1,000 locked =====
  // 잠금이 LIMIT '이후'에 적용되면 앞 1,000 locked prefix만 재선정돼 healed=0으로
  // 무한 반복, 뒤 unlocked 행 starve. lock-before-limit이면 같은 tick에 heal.
  // g=1..1001 → user_id 마지막 12hex = '0000'||'0007'||lpad(g,4) → 정렬상 g 오름차순.
  const g7uid = "('00000000-0000-0000-0000-' || '0000' || '0007' || lpad(g::text,4,'0'))::uuid";
  psql(`insert into live_activity_channels(game_id,environment,channel_id,status) values ('G7','production','C7','active')`);
  psql(`insert into live_activity_started_users(game_id,user_id)
        select 'G7', ${g7uid} from generate_series(1,1001) g`);
  psql(`insert into live_activity_channel_subscriptions(game_id,device_key,environment,channel_id,user_id)
        select 'G7', 'd7_'||g, 'production', 'C7', ${g7uid} from generate_series(1,1001) g`);
  const boundaryUid = psql(`select ('00000000-0000-0000-0000-' || '0000' || '0007' || lpad(1001::text,4,'0'))::text`);
  // 정렬상 앞 1,000행(user_id < 1001번째) FOR UPDATE로 6초 보유.
  const lockPrefix = holdLock(`select 1 from live_activity_started_users where game_id='G7' and user_id < '${boundaryUid}' for update`, 6);
  await sleep(1500); // 1,000행 lock 획득 시간
  r = reconcile();
  check("batch boundary: reconcile still returns bounded under 1000 locked (<2500ms)", r.ms < 2500);
  check("batch boundary: unlocked tail row heals in the SAME tick (no starvation)", r.healed === 1);
  check("batch boundary: the single unlocked row is the 1001st", psql(`select channel_born_channel_id from live_activity_started_users where game_id='G7' and user_id='${boundaryUid}'`) === "C7");
  check("batch boundary: locked prefix stays unmarked this tick", bornCount("G7") === 1);
  await new Promise((res) => lockPrefix.on("exit", res));
  r = reconcile();
  check("batch boundary: prefix fully heals after release", bornCount("G7") === 1001 && r.healed === 1000);

  // ===== Test 6: active 세대 상한 초과 시 실패로 드러냄 =====
  for (let i = 0; i < 34; i++) psql(`insert into live_activity_channels(game_id,environment,channel_id,status) values ('BND${i}','production','x','active')`);
  let raised = false;
  try { psql(`select reconcile_live_activity_channel_born(1000)`); } catch { raised = true; }
  check("excess active generations raise (not silent partial)", raised);

  console.log(`la-channel-born-reconcile PG integration: ${checks}/${checks} PASS`);
  teardown();
  process.exit(0);
} catch (err) {
  console.error(err?.message || err);
  fail("unexpected error");
}
