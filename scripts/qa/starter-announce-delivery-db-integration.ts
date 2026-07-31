/**
 * 예고선발 공개 알림 원장 DB 통합 테스트 (PGlite) — 20260730_starter_announce_notify.sql 을 실제 적용해
 * 삼순 조건부 GO 계약을 고정한다:
 *  - 빈값→공식값 최초 관측 1회만 snapshot (재수집/cron 중복 실행 중복 0), 발송 성공 뒤 starter_notified 전진
 *  - (game_id, team_id) 분리(더블헤더 gameId 상이·팀 분리), deadline 만료 fail-safe
 *  - 최애팀 + notification_prefs.starter_announce(coalesce true) + 유효 토큰만 원장 대상
 *  - 종결 뒤 재snapshot 중복 0 = 선발 '변경'(공식값→다른 공식값) 재발송 없음(동일 메커니즘)
 *  - lease fencing / at-most-once dispatch intent / 멱등 키
 *  - [NO-GO 재작업] observe 원장: 최초 관측 기공개=baseline(발송 금지) · 실제 빈값→공식값=emit ·
 *    종결 state 에 snapshot RPC 재호출 시 null 반환(완료 state 완전 skip 근거)
 * 실행: npm run qa:starter-announce-delivery:db
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
      create table notification_prefs (user_id uuid primary key, starter_announce boolean, lineup_confirm boolean);
    `);
    // 실 migration 은 pgcrypto(create extension)를 쓰지만 PGlite 엔 없으므로 그 라인만 제거하고 적용.
    const migrationSql = readFileSync(resolve("supabase/migrations/20260730_starter_announce_notify.sql"), "utf8")
      .replace(/create extension if not exists pgcrypto[^;]*;/i, "");
    await db.exec(migrationSql);

    // ── 픽스처: LG(팀1) 팬 3명 — A(pref 미설정=on), B(starter_announce=true), C(starter_announce=false 제외) ──
    const A = "11111111-1111-1111-1111-111111111111";
    const B = "22222222-2222-2222-2222-222222222222";
    const C = "33333333-3333-3333-3333-333333333333";
    const O = "44444444-4444-4444-4444-444444444444"; // 다른 팀(2) 팬 — 제외
    await db.exec(`
      insert into profiles(id, team_id) values
        ('${A}',1),('${B}',1),('${C}',1),('${O}',2);
      insert into device_push_tokens(user_id, fcm_token, platform) values
        ('${A}','tokA','ios'),('${B}','tokB','android'),('${C}','tokC','ios'),('${O}','tokO','ios');
      insert into notification_prefs(user_id, starter_announce) values
        ('${B}',true),('${C}',false);
    `);

    const G = "20260730LGWO0";
    async function snapshot(g: string, team: number) {
      await db.query(
        "select snapshot_starter_announce_deliveries($1,$2, now(), now() + interval '90 seconds', $3, $4, $5)",
        [g, team, `${team} 예고선발 공개`, `예고선발이 공개되었습니다.`, `/games/${g}`],
      );
    }
    const ledgerCount = (g: string, team: number) =>
      scalar(db, "select count(*)::int c from starter_announce_delivery_ledger where game_id=$1 and team_id=$2", [g, team]);
    const notified = (g: string, team: number) =>
      scalar(db, "select (starter_notified)::int c from game_starter_notify_state where game_id=$1 and team_id=$2", [g, team]);

    // ── pref 게이트 + 팀 필터: LG 팬 중 opt-in(A,B)만, C(off)·O(다른팀) 제외 ──
    await snapshot(G, 1);
    ok("snapshot → 대상 2건(A pref미설정=on, B on)", (await ledgerCount(G, 1)) === 2);
    ok("snapshot payload 저장(title/body/url)", (await scalar(db, "select count(*)::int c from game_starter_notify_state where game_id=$1 and team_id=1 and push_title = $2 and push_url = $3", [G, "1 예고선발 공개", `/games/${G}`])) === 1);
    {
      const due = await db.query<{ game_id: string; team_id: number; push_title: string; push_url: string }>(
        "select game_id, team_id, push_title, push_url from list_due_starter_announce_snapshots(200) where game_id=$1 and team_id=1", [G]);
      ok("list_due → 미완료 스냅샷 1건 반환", due.rows.length === 1 && due.rows[0]?.push_title === "1 예고선발 공개" && due.rows[0]?.push_url === `/games/${G}`);
    }
    ok("starter_announce=false(C) 제외", (await scalar(db, "select count(*)::int c from starter_announce_delivery_ledger where token_hash = encode(extensions.digest('tokC','sha256'),'hex')")) === 0);
    ok("다른 팀 팬(O) 제외", (await scalar(db, "select count(*)::int c from starter_announce_delivery_ledger where token_hash = encode(extensions.digest('tokO','sha256'),'hex')")) === 0);

    // ── 재수집/cron 중복 실행 → 새 스냅샷/행 생성 안 함(중복 0) ──
    await snapshot(G, 1);
    ok("재snapshot(재수집) → 원장 여전히 2건(중복 0)", (await ledgerCount(G, 1)) === 2);
    ok("스냅샷 전 starter_notified=false", (await notified(G, 1)) === 0);

    // ── (game,team) 분리: away팀·더블헤더 gameId 상이는 독립 ──
    await snapshot(G, 10);
    ok("away팀 스냅샷 독립 생성(state 행 2)", (await scalar(db, "select count(*)::int c from game_starter_notify_state where game_id=$1", [G])) === 2);
    const G2 = "20260730LGWO1"; // 더블헤더 2차전
    await snapshot(G2, 1);
    ok("더블헤더 2차전(gameId 상이) 독립 스냅샷(경기별 각 1회)", (await ledgerCount(G2, 1)) === 2);

    // ── claim → mark dispatching → settle(accepted) → finalize → starter_notified 전진 ──
    const lease = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const claimed = await db.query<{ id: string }>(
      "select id from claim_starter_announce_deliveries($1,$2,$3::uuid,45,500)", [G, 1, lease]);
    ok("claim → 2건 lease", claimed.rows.length === 2);
    const ids = claimed.rows.map((r) => r.id);
    const marked = await scalar(db, "select mark_starter_announce_deliveries_dispatching($1::uuid[],$2::uuid) c", [ids, lease]);
    ok("mark dispatching → 2건 intent", marked === 2);
    const reclaim = await db.query("select id from claim_starter_announce_deliveries($1,$2,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,45,500)", [G, 1]);
    ok("dispatch intent 후 재claim 0(at-most-once)", reclaim.rows.length === 0);
    const results = JSON.stringify(ids.map((id) => ({ id, status: "accepted" })));
    const acc = await scalar(db, "select settle_starter_announce_delivery_batch($1::jsonb,$2::uuid) c", [results, lease]);
    ok("settle batch → accepted 2", acc === 2);
    const fin = await db.query<{ snapshot_completed: boolean; pending: number | string }>(
      "select snapshot_completed, pending from finalize_starter_announce_deliveries($1,$2)", [G, 1]);
    ok("finalize → pending 0", Number(fin.rows[0]?.pending) === 0);
    ok("finalize → snapshot_completed=true", fin.rows[0]?.snapshot_completed === true);
    ok("발송 성공 뒤 starter_notified=true 전진", (await notified(G, 1)) === 1);
    ok("종결 후 list_due 에서 제외", (await scalar(db, "select count(*)::int c from list_due_starter_announce_snapshots(200) where game_id=$1 and team_id=1", [G])) === 0);
    ok("accepted 뒤 fcm_token NULL(활성 credential 미보존)", (await scalar(db, "select count(*)::int c from starter_announce_delivery_ledger where game_id=$1 and team_id=1 and fcm_token is not null", [G])) === 0);

    // ── 종결 뒤 재snapshot → 새 행 0 = 선발 '변경' 재발송 없음(1회 계약) ──
    await snapshot(G, 1);
    ok("종결 뒤 재snapshot(선발 변경 재관측) 중복 0", (await ledgerCount(G, 1)) === 2);

    // ── [NO-GO 재작업 3] 종결된 state 에 snapshot RPC 재호출 → null(호출부 Phase A 완전 skip 근거) ──
    {
      const r = await db.query<{ d: string | null }>(
        "select snapshot_starter_announce_deliveries($1,1, now(), now() + interval '90 seconds') d", [G]);
      ok("종결 state 재호출 → null 반환(drain/finalize skip 신호)", r.rows[0]?.d === null);
    }
    {
      // 미종결(열린) state 는 여전히 기존 deadline 을 반환(이어 drain 경로 유지).
      const r = await db.query<{ d: string | null }>(
        "select snapshot_starter_announce_deliveries($1,10, now(), now() + interval '90 seconds') d", [G]);
      ok("미종결 state 재호출 → 기존 deadline 반환(null 아님)", r.rows[0]?.d !== null);
    }

    // ── [NO-GO 재작업 2] observe 원장: baseline / 실제 전이 emit / wait ──
    {
      const obs = (arr: Array<{ game_id: string; both_official: boolean }>) =>
        db.query<{ game_id: string; action: string }>(
          "select game_id, action from observe_starter_announce_games($1::jsonb)", [JSON.stringify(arr)]);
      // 최초 관측부터 공식값(배포 시점 기공개) → baseline, 재관측도 baseline 유지.
      const b1 = await obs([{ game_id: "OBS-BASE", both_official: true }]);
      ok("최초 관측 기공개 → baseline(발송 금지)", b1.rows[0]?.action === "baseline");
      const b2 = await obs([{ game_id: "OBS-BASE", both_official: true }]);
      ok("재관측도 baseline 유지(emit 승격 없음)", b2.rows[0]?.action === "baseline");
      const bGap = await obs([{ game_id: "OBS-BASE", both_official: false }]);
      ok("baseline 경기 일시 공백 → baseline 고정", bGap.rows[0]?.action === "baseline");
      const bRestore = await obs([{ game_id: "OBS-BASE", both_official: true }]);
      ok("baseline 경기 공백 뒤 복구 → baseline 고정(지연 발송 없음)", bRestore.rows[0]?.action === "baseline");
      // 빈값 관측 → wait, 이후 공식값 → emit(실제 전이).
      const w1 = await obs([{ game_id: "OBS-TRANS", both_official: false }]);
      ok("빈값 관측 → wait", w1.rows[0]?.action === "wait");
      const e1 = await obs([{ game_id: "OBS-TRANS", both_official: true }]);
      ok("빈값 관측 후 공식값 → emit(실제 전이)", e1.rows[0]?.action === "emit");
      // batch: 여러 경기 한 번에, 각자 독립 판정.
      const m = await obs([
        { game_id: "OBS-BASE", both_official: true },
        { game_id: "OBS-TRANS", both_official: true },
        { game_id: "OBS-NEW", both_official: false },
      ]);
      const byId = new Map(m.rows.map((r) => [r.game_id, r.action]));
      ok("batch 관측 — baseline/emit/wait 독립 판정", byId.get("OBS-BASE") === "baseline" && byId.get("OBS-TRANS") === "emit" && byId.get("OBS-NEW") === "wait");
    }

    // ── deadline 만료 fail-safe: 미발송 스냅샷은 finalize 시 expired ──
    const GF = "20260730SSNC0";
    await db.exec(`insert into profiles(id,team_id) values ('55555555-5555-5555-5555-555555555555',4);
      insert into device_push_tokens(user_id,fcm_token,platform) values ('55555555-5555-5555-5555-555555555555','tokF','ios');`);
    await db.query("select snapshot_starter_announce_deliveries($1,$2, now() - interval '2 minutes', now() - interval '1 second')", [GF, 4]);
    ok("만료 스냅샷 원장 1건(pending)", (await ledgerCount(GF, 4)) === 1);
    const finF = await db.query<{ expired: number | string; snapshot_completed: boolean }>(
      "select expired, snapshot_completed from finalize_starter_announce_deliveries($1,$2)", [GF, 4]);
    ok("deadline 경과 → expired 1(fail-safe)", Number(finF.rows[0]?.expired) === 1);
    ok("만료 종결 → snapshot_completed=true", finF.rows[0]?.snapshot_completed === true);

    // ── 권한: anon/authenticated RPC 실행 불가 ──
    const fnDenied = async (role: string, sig: string) =>
      (await db.query<{ ok: boolean }>("select has_function_privilege($1,$2,'EXECUTE') ok", [role, sig])).rows[0]?.ok === false;
    ok("anon snapshot RPC 차단", await fnDenied("anon", "snapshot_starter_announce_deliveries(text,integer,timestamptz,timestamptz,text,text,text)"));
    ok("authenticated claim RPC 차단", await fnDenied("authenticated", "claim_starter_announce_deliveries(text,integer,uuid,integer,integer)"));
    ok("anon list_due RPC 차단", await fnDenied("anon", "list_due_starter_announce_snapshots(integer)"));
    ok("anon observe RPC 차단", await fnDenied("anon", "observe_starter_announce_games(jsonb)"));
  } finally {
    await db.close();
  }
  console.log(`\nstarter-announce delivery ledger: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
