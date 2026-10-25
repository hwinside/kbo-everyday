/**
 * 라인업 확정 알림 원장 DB 통합 테스트 (PGlite) — 20260729_lineup_confirm_notify.sql 을 실제 적용해
 * 하린아빠 gate ①②③ 계약을 고정한다:
 *  - ① 미확정→확정 최초 1회만 snapshot (재호출/재배포 중복 0), 발송 성공 뒤 lineup_notified 전진
 *  - ② (game_id, team_id) 분리(더블헤더 gameId 상이·팀 분리), deadline 만료 fail-safe
 *  - ③ 최애팀 + notification_prefs.lineup_confirm(coalesce true) + 유효 토큰만 원장 대상
 *  - lease fencing / at-most-once dispatch intent / 멱등 키
 * 실행: npm run qa:lineup-confirm-delivery:db
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  ✗ " + name);
  }
}

async function scalar(db: PGlite, sql: string, params: unknown[] = []): Promise<number> {
  const r = await db.query<{ c: number | string }>(sql, params);
  return Number((r.rows[0] as { c: number | string } | undefined)?.c ?? 0);
}

async function main() {
  const db = new PGlite();
  await db.waitReady;
  try {
    // 의존 테이블 최소 스키마 (실제 앱 스키마의 관련 컬럼만).
    await db.exec(`
      create schema if not exists extensions;
      create or replace function extensions.digest(data text, algo text) returns bytea
        language sql immutable as $fn$ select convert_to(data, 'UTF8') $fn$;
      do $$ begin
        if not exists (select from pg_roles where rolname='service_role') then create role service_role; end if;
        if not exists (select from pg_roles where rolname='anon') then create role anon; end if;
        if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
      end $$;
      create table profiles (id uuid primary key, team_id integer);
      create table device_push_tokens (
        id bigserial primary key, user_id uuid not null, fcm_token text not null,
        platform text not null check (platform in ('ios','android'))
      );
      create table notification_prefs (user_id uuid primary key, lineup_confirm boolean, game_start boolean);
    `);
    // 실 migration 은 pgcrypto(create extension)를 쓰지만 PGlite 엔 없으므로 그 라인만 제거하고 적용.
    const migrationSql = readFileSync(resolve("supabase/migrations/20260729_lineup_confirm_notify.sql"), "utf8")
      .replace(/create extension if not exists pgcrypto[^;]*;/i, "");
    await db.exec(migrationSql);
    await db.exec(readFileSync(resolve("supabase/migrations/20260731212000_lineup_notify_retry_outcome.sql"), "utf8"));

    // ── 픽스처: LG(팀1) 팬 3명 — A(pref 미설정=on), B(lineup_confirm=true), C(lineup_confirm=false 제외) ──
    const A = "11111111-1111-1111-1111-111111111111";
    const B = "22222222-2222-2222-2222-222222222222";
    const C = "33333333-3333-3333-3333-333333333333";
    const O = "44444444-4444-4444-4444-444444444444"; // 다른 팀(2) 팬 — 제외
    await db.exec(`
      insert into profiles(id, team_id) values
        ('${A}',1),('${B}',1),('${C}',1),('${O}',2);
      insert into device_push_tokens(user_id, fcm_token, platform) values
        ('${A}','tokA','ios'),('${B}','tokB','android'),('${C}','tokC','ios'),('${O}','tokO','ios');
      insert into notification_prefs(user_id, lineup_confirm) values
        ('${B}',true),('${C}',false);
    `);

    const G = "20260729LGWO0";
    async function snapshot(g: string, team: number) {
      await db.query(
        "select snapshot_lineup_confirm_deliveries($1,$2, now(), now() + interval '90 seconds', $3, $4, $5)",
        [g, team, `${team} 라인업 확정`, `금일 라인업이 확정되었습니다.`, `/games/${g}?tab=lineup`],
      );
    }
    const ledgerCount = (g: string, team: number) =>
      scalar(db, "select count(*)::int c from lineup_confirm_delivery_ledger where game_id=$1 and team_id=$2", [g, team]);
    const notified = (g: string, team: number) =>
      scalar(db, "select (lineup_notified)::int c from game_lineup_notify_state where game_id=$1 and team_id=$2", [g, team]);
    const stateStatus = async (g: string, team: number) => {
      const r = await db.query<{ delivery_status: string }>(
        "select delivery_status from game_lineup_notify_state where game_id=$1 and team_id=$2", [g, team]);
      return r.rows[0]?.delivery_status;
    };

    // ── ③ pref 게이트 + 팀 필터: LG 팬 중 opt-in(A,B)만, C(off)·O(다른팀) 제외 ──
    await snapshot(G, 1);
    ok("snapshot → 대상 2건(A pref미설정=on, B on)", (await ledgerCount(G, 1)) === 2);
    // (re-gate ③) snapshot 이 push payload 를 durable 하게 보존 → due drainer 가 재현.
    ok("snapshot payload 저장(title/body/url)", (await scalar(db, "select count(*)::int c from game_lineup_notify_state where game_id=$1 and team_id=1 and push_title = $2 and push_url = $3", [G, "1 라인업 확정", `/games/${G}?tab=lineup`])) === 1);
    // (re-gate ③) list_due: 미완료 스냅샷을 payload 와 함께 반환.
    {
      const due = await db.query<{ game_id: string; team_id: number; push_title: string; push_url: string }>(
        "select game_id, team_id, push_title, push_url from list_due_lineup_confirm_snapshots(200) where game_id=$1 and team_id=1", [G]);
      ok("list_due → 미완료 스냅샷 1건 반환", due.rows.length === 1 && due.rows[0]?.push_title === "1 라인업 확정" && due.rows[0]?.push_url === `/games/${G}?tab=lineup`);
    }
    ok("lineup_confirm=false(C) 제외", (await scalar(db, "select count(*)::int c from lineup_confirm_delivery_ledger where token_hash = encode(extensions.digest('tokC','sha256'),'hex')")) === 0);
    ok("다른 팀 팬(O) 제외", (await scalar(db, "select count(*)::int c from lineup_confirm_delivery_ledger where token_hash = encode(extensions.digest('tokO','sha256'),'hex')")) === 0);

    // ── ① 재호출(폴링/재배포) → 새 스냅샷/행 생성 안 함(중복 0) ──
    await snapshot(G, 1);
    ok("재snapshot → 원장 여전히 2건(중복 0)", (await ledgerCount(G, 1)) === 2);
    ok("스냅샷 전 lineup_notified=false", (await notified(G, 1)) === 0);

    // ── ② (game,team) 분리: 같은 게임 away팀(WO=team10 가정)·더블헤더 gameId 상이는 독립 ──
    await snapshot(G, 10);
    ok("away팀 스냅샷 독립 생성(팀10 팬 0명 → 0건이지만 state 행 생성)", (await scalar(db, "select count(*)::int c from game_lineup_notify_state where game_id=$1", [G])) === 2);
    const G2 = "20260729LGWO1"; // 더블헤더 2차전
    await snapshot(G2, 1);
    ok("더블헤더 2차전(gameId 상이) 독립 스냅샷", (await ledgerCount(G2, 1)) === 2);

    // ── claim → mark dispatching → settle(accepted) → finalize → lineup_notified 전진 ──
    const lease = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const claimed = await db.query<{ id: string }>(
      "select id from claim_lineup_confirm_deliveries($1,$2,$3::uuid,45,500)", [G, 1, lease]);
    ok("claim → 2건 lease", claimed.rows.length === 2);
    const ids = claimed.rows.map((r) => r.id);
    const marked = await scalar(db, "select mark_lineup_confirm_deliveries_dispatching($1::uuid[],$2::uuid) c", [ids, lease]);
    ok("mark dispatching → 2건 intent", marked === 2);
    // 재claim 차단(dispatch intent 후 lease_until=deadline)
    const reclaim = await db.query("select id from claim_lineup_confirm_deliveries($1,$2,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,45,500)", [G, 1]);
    ok("dispatch intent 후 재claim 0(at-most-once)", reclaim.rows.length === 0);
    const results = JSON.stringify(ids.map((id) => ({ id, status: "accepted" })));
    const acc = await scalar(db, "select settle_lineup_confirm_delivery_batch($1::jsonb,$2::uuid) c", [results, lease]);
    ok("settle batch → accepted 2", acc === 2);
    const fin = await db.query<{ snapshot_completed: boolean; pending: number | string }>(
      "select snapshot_completed, pending from finalize_lineup_confirm_deliveries($1,$2)", [G, 1]);
    ok("finalize → pending 0", Number(fin.rows[0]?.pending) === 0);
    ok("finalize → snapshot_completed=true", fin.rows[0]?.snapshot_completed === true);
    ok("발송 성공 뒤 lineup_notified=true 전진(gate ①)", (await notified(G, 1)) === 1);
    // (re-gate ③) 종결된 스냅샷은 due 목록에서 제외(재drain 대상 아님).
    ok("종결 후 list_due 에서 제외", (await scalar(db, "select count(*)::int c from list_due_lineup_confirm_snapshots(200) where game_id=$1 and team_id=1", [G])) === 0);
    ok("accepted 뒤 fcm_token NULL(활성 credential 미보존)", (await scalar(db, "select count(*)::int c from lineup_confirm_delivery_ledger where game_id=$1 and team_id=1 and fcm_token is not null", [G])) === 0);

    // ── ① 종결 뒤 재snapshot → 새 행 0(이미 notified) ──
    await snapshot(G, 1);
    ok("종결 뒤 재snapshot 중복 0", (await ledgerCount(G, 1)) === 2);

    // ── ② deadline 만료 fail-safe: 미발송 스냅샷은 finalize 시 expired ──
    const GF = "20260729SSNC0";
    await db.exec(`insert into profiles(id,team_id) values ('55555555-5555-5555-5555-555555555555',4);
      insert into device_push_tokens(user_id,fcm_token,platform) values ('55555555-5555-5555-5555-555555555555','tokF','ios');`);
    await db.query("select snapshot_lineup_confirm_deliveries($1,$2, now() - interval '2 minutes', now() - interval '1 second')", [GF, 4]);
    ok("만료 스냅샷 원장 1건(pending)", (await ledgerCount(GF, 4)) === 1);
    const finF = await db.query<{ expired: number | string; snapshot_completed: boolean }>(
      "select expired, snapshot_completed from finalize_lineup_confirm_deliveries($1,$2)", [GF, 4]);
    ok("deadline 경과 → expired 1(fail-safe)", Number(finF.rows[0]?.expired) === 1);
    ok("만료 종결 → snapshot_completed=true", finF.rows[0]?.snapshot_completed === true);
    ok("만료 종결 → failed 보존(lineup_notified 오판 금지)", (await stateStatus(GF, 4)) === "failed" && (await notified(GF, 4)) === 0);
    ok("만료 종결 → expired_count=1 보존", (await scalar(db, "select expired_count c from game_lineup_notify_state where game_id=$1 and team_id=$2", [GF, 4])) === 1);

    // ── partial terminal: 일부 accepted + 일부 permanent_failed를 성공으로 뭉개지 않는다 ──
    const GP = "20260729OBKT0";
    await db.exec(`
      insert into profiles(id,team_id) values
        ('66666666-6666-6666-6666-666666666661',3),
        ('66666666-6666-6666-6666-666666666662',3);
      insert into device_push_tokens(user_id,fcm_token,platform) values
        ('66666666-6666-6666-6666-666666666661','tokP1','ios'),
        ('66666666-6666-6666-6666-666666666662','tokP2','android');
    `);
    await snapshot(GP, 3);
    const leaseP = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const claimP = await db.query<{ id: string }>(
      "select id from claim_lineup_confirm_deliveries($1,$2,$3::uuid,45,500)", [GP, 3, leaseP]);
    const idsP = claimP.rows.map((r) => r.id);
    await db.query("select mark_lineup_confirm_deliveries_dispatching($1::uuid[],$2::uuid)", [idsP, leaseP]);
    await db.query("select settle_lineup_confirm_delivery_batch($1::jsonb,$2::uuid)", [JSON.stringify([
      { id: idsP[0], status: "accepted" },
      { id: idsP[1], status: "permanent_failed", error: "messaging/registration-token-not-registered" },
    ]), leaseP]);
    await db.query("select * from finalize_lineup_confirm_deliveries($1,$2)", [GP, 3]);
    ok("partial accepted → delivery_status=partial", (await stateStatus(GP, 3)) === "partial");
    ok("partial accepted → lineup_notified=false", (await notified(GP, 3)) === 0);
    ok("partial counters 보존", (await scalar(db, "select accepted_count c from game_lineup_notify_state where game_id=$1 and team_id=$2", [GP, 3])) === 1
      && (await scalar(db, "select permanent_failed_count c from game_lineup_notify_state where game_id=$1 and team_id=$2", [GP, 3])) === 1);
    ok("partial terminal은 due drain에서 제외", (await scalar(db, "select count(*) c from list_due_lineup_confirm_snapshots(200) where game_id=$1 and team_id=$2", [GP, 3])) === 0);

    // ── 501-token 전체 transport 장애: 실패 500 backoff 중 미시도 1개가 먼저 drain되고,
    //    동일 500개도 2회 cap을 넘어 4번째 시도에서 복구한다 ──
    const GR = "20260729HHHT0";
    const R = "77777777-7777-7777-7777-777777777777";
    await db.exec(`
      insert into profiles(id,team_id) values ('${R}',7);
      insert into device_push_tokens(user_id,fcm_token,platform)
      select '${R}', 'tokR' || gs::text, case when gs % 2 = 0 then 'ios' else 'android' end
      from generate_series(1,501) gs;
    `);
    await snapshot(GR, 7);
    const transientRound = async (lease: string) => {
      const claim = await db.query<{ id: string }>(
        "select id from claim_lineup_confirm_deliveries($1,$2,$3::uuid,45,500)", [GR, 7, lease]);
      const ids = claim.rows.map((r) => r.id);
      await db.query("select mark_lineup_confirm_deliveries_dispatching($1::uuid[],$2::uuid)", [ids, lease]);
      await db.query("select settle_lineup_confirm_delivery_batch($1::jsonb,$2::uuid)", [
        JSON.stringify(ids.map((id) => ({ id, status: "transient", error: "messaging/server-unavailable" }))), lease]);
      return ids;
    };
    const first500 = await transientRound("10000000-0000-0000-0000-000000000001");
    ok("500-token server-unavailable → 500 transient", first500.length === 500);
    const fairLease = "10000000-0000-0000-0000-000000000002";
    const fair = await db.query<{ id: string }>(
      "select id from claim_lineup_confirm_deliveries($1,$2,$3::uuid,45,500)", [GR, 7, fairLease]);
    ok("실패 batch backoff 중 미시도 token 굶김 없음", fair.rows.length === 1);
    const fairIds = fair.rows.map((r) => r.id);
    await db.query("select mark_lineup_confirm_deliveries_dispatching($1::uuid[],$2::uuid)", [fairIds, fairLease]);
    await db.query("select settle_lineup_confirm_delivery_batch($1::jsonb,$2::uuid)", [
      JSON.stringify(fairIds.map((id) => ({ id, status: "accepted" }))), fairLease]);
    for (let round = 2; round <= 3; round++) {
      await db.query("update lineup_confirm_delivery_ledger set next_attempt_at=now() where game_id=$1 and team_id=$2 and status='transient'", [GR, 7]);
      const ids = await transientRound(`10000000-0000-0000-0000-00000000000${round + 1}`);
      ok(`500-token transient 재시도 ${round}회`, ids.length === 500);
    }
    await db.query("update lineup_confirm_delivery_ledger set next_attempt_at=now() where game_id=$1 and team_id=$2 and status='transient'", [GR, 7]);
    const recoveryLease = "10000000-0000-0000-0000-000000000005";
    const recovered = await db.query<{ id: string }>(
      "select id from claim_lineup_confirm_deliveries($1,$2,$3::uuid,45,500)", [GR, 7, recoveryLease]);
    const recoveredIds = recovered.rows.map((r) => r.id);
    await db.query("select mark_lineup_confirm_deliveries_dispatching($1::uuid[],$2::uuid)", [recoveredIds, recoveryLease]);
    await db.query("select settle_lineup_confirm_delivery_batch($1::jsonb,$2::uuid)", [
      JSON.stringify(recoveredIds.map((id) => ({ id, status: "accepted" }))), recoveryLease]);
    await db.query("select * from finalize_lineup_confirm_deliveries($1,$2)", [GR, 7]);
    ok("2회 초과(4번째) 500-token recovery", recoveredIds.length === 500
      && (await scalar(db, "select count(*) c from lineup_confirm_delivery_ledger where game_id=$1 and team_id=$2 and attempts=4 and status='accepted'", [GR, 7])) === 500);
    ok("501 accepted·duplicate 0·delivered", (await scalar(db, "select accepted_count c from game_lineup_notify_state where game_id=$1 and team_id=$2", [GR, 7])) === 501
      && (await ledgerCount(GR, 7)) === 501
      && (await stateStatus(GR, 7)) === "delivered");

    // ── 권한: anon/authenticated RPC 실행 불가 ──
    const fnDenied = async (role: string, sig: string) =>
      (await db.query<{ ok: boolean }>("select has_function_privilege($1,$2,'EXECUTE') ok", [role, sig])).rows[0]?.ok === false;
    ok("anon snapshot RPC 차단", await fnDenied("anon", "snapshot_lineup_confirm_deliveries(text,integer,timestamptz,timestamptz,text,text,text)"));
    ok("authenticated claim RPC 차단", await fnDenied("authenticated", "claim_lineup_confirm_deliveries(text,integer,uuid,integer,integer)"));
    ok("anon list_due RPC 차단", await fnDenied("anon", "list_due_lineup_confirm_snapshots(integer)"));
  } finally {
    await db.close();
  }
  console.log(`\nlineup-confirm delivery ledger: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
