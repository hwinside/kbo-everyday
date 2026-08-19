/**
 * API 열화 durable 경보 outbox(claim/drain/confirm/nack, 토큰 소유) DB 통합 테스트 (PGlite).
 * 20260729_api_fallback_alert_claim.sql 을 실제 적용해 삼순 3차 NO-GO 계약을 고정한다:
 *  - 단발 outage + NACK → 새 열화 이벤트 없이 drainer due retry → 2xx confirm (P0)
 *  - lease A 만료/B(drain) 재claim(토큰 회전) 뒤 stale A confirm → no-op (P1)
 *  - confirm 은 정확히 그 outbox 의 event_id 만 sent 마킹 (exact 귀속)
 *  - cooldown/lease/window/입력방어/RLS·RPC deny
 * (실제 멀티커넥션 advisory-lock race 는 별도 PG17 harness)
 * 실행: npm run qa:api-fallback-alert-claim:db
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

function migration(name: string) {
  return readFileSync(resolve("supabase/migrations", name), "utf8");
}

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  ✗ " + name);
  }
}

type Policy = { win: number; thr: number; cd: number; lease: number };
const SUCCESS: Policy = { win: 5, thr: 3, cd: 30, lease: 120 };
const OUTAGE: Policy = { win: 5, thr: 1, cd: 10, lease: 120 };

async function claim(
  db: PGlite,
  api: string,
  p: Policy,
  errMsg = "test",
  scope: string | null = null,
): Promise<{ send: boolean; token: string | null }> {
  const r = await db.query<{ should_send: boolean; attempt_token: string | null }>(
    "select should_send, attempt_token from public.claim_api_fallback_alert($1,'schema-error',null,$2,$3,$4,$5,$6,$7)",
    [api, errMsg, p.win, p.thr, p.cd, p.lease, scope],
  );
  return { send: r.rows[0]?.should_send === true, token: r.rows[0]?.attempt_token ?? null };
}

/** 버킷 행 수(= DB 쓰기 량). 폴링 증폭 차단 여부는 이 값으로 본다. */
async function rowCount(db: PGlite, api: string): Promise<number> {
  const r = await db.query<{ c: number | string }>(
    "select count(*)::int as c from public.api_fallback_events where api_name=$1",
    [api],
  );
  return Number(r.rows[0]?.c ?? 0);
}

/** 발생 횟수(= sum(event_count)). 임계치 판정은 반드시 이 값이어야 한다. */
async function occurrenceCount(db: PGlite, api: string): Promise<number> {
  const r = await db.query<{ c: number | string }>(
    "select coalesce(sum(coalesce(event_count,1)),0)::int as c from public.api_fallback_events where api_name=$1",
    [api],
  );
  return Number(r.rows[0]?.c ?? 0);
}
async function drain(
  db: PGlite,
  lease = 120,
  maxAge = 120,
  batch = 20,
): Promise<Array<{ api_name: string; attempt_token: string; reason: string; error_message: string | null }>> {
  const r = await db.query<{ api_name: string; attempt_token: string; reason: string; error_message: string | null }>(
    "select api_name, attempt_token, reason, error_message from public.drain_api_fallback_alerts($1,$2,$3)",
    [lease, maxAge, batch],
  );
  return r.rows;
}
async function confirm(db: PGlite, api: string, token: string): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(
    "select public.confirm_api_fallback_alert($1,$2::uuid) as ok",
    [api, token],
  );
  return r.rows[0]?.ok === true;
}
async function nack(db: PGlite, api: string, token: string, backoff = 60): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(
    "select public.nack_api_fallback_alert($1,$2::uuid,$3) as ok",
    [api, token, backoff],
  );
  return r.rows[0]?.ok === true;
}
/**
 * 기존 단언("이벤트 N건 durable")은 버킷 도입 전엔 row 수 == 발생 횟수였다.
 * 이제 둘은 갈라진다 — 의미상 "몇 번 일어났는가"를 묻는 검증은 occurrenceCount 를 쓴다.
 */
async function eventCount(db: PGlite, api: string): Promise<number> {
  return occurrenceCount(db, api);
}
async function sentIds(db: PGlite, api: string): Promise<number[]> {
  const r = await db.query<{ id: number | string }>(
    "select id from public.api_fallback_events where api_name=$1 and alert_sent=true order by id",
    [api],
  );
  return r.rows.map((x) => Number(x.id));
}
async function expireLease(db: PGlite, api: string) {
  await db.exec(
    `update public.api_fallback_alert_state set locked_until = now() - interval '1 second', next_attempt_at = now() - interval '1 second' where api_name = '${api}'`,
  );
}

async function main() {
  const db = new PGlite();
  await db.waitReady;
  try {
    await db.exec(`
      do $$ begin
        if not exists (select from pg_roles where rolname='service_role') then create role service_role; end if;
        if not exists (select from pg_roles where rolname='anon') then create role anon; end if;
        if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
      end $$;
      create table if not exists public.api_fallback_events (
        id bigserial primary key,
        api_name text not null,
        reason text not null,
        status_code int,
        error_message text,
        timestamp timestamptz not null default now(),
        alert_sent boolean default false
      );
      create index if not exists idx_afe_composite on public.api_fallback_events(api_name, timestamp desc);
    `);
    await db.exec(migration("20260729_api_fallback_alert_claim.sql"));
    await db.exec(migration("20260820000000_api_fallback_events_bucket.sql"));

    const A = "kbo-scoreboard-linescore";

    // ── 임계 미달 → 전송 안 함 ──
    ok("1번째 → 미달 → should_send=false", (await claim(db, A, SUCCESS)).send === false);
    ok("2번째 → 미달 → false", (await claim(db, A, SUCCESS)).send === false);

    // ── 3번째 임계 도달 → should_send=true + token ──
    const c3 = await claim(db, A, SUCCESS);
    ok("3번째 → 임계 → should_send=true", c3.send === true);
    ok("3번째 → attempt_token 발급", !!c3.token);
    ok("이벤트 3건 durable", (await eventCount(db, A)) === 3);
    ok("confirm 전 sent 마킹 0건", (await sentIds(db, A)).length === 0);

    // ── outbox 활성 중 재claim → false(중복 outbox 생성 안 함) ──
    ok("outbox 활성 중 재claim → false", (await claim(db, A, SUCCESS)).send === false);

    // ── [P1] stale confirm no-op: A 만료 → B(drain) 재claim(토큰 회전) → 늦은 A confirm no-op ──
    await expireLease(db, A);
    const bRows = await drain(db);
    ok("만료 후 drain 이 due outbox 재획득(1건)", bRows.length === 1 && bRows[0].api_name === A);
    const bToken = bRows[0]?.attempt_token;
    ok("drain 토큰이 A 토큰과 다름(회전)", !!bToken && bToken !== c3.token);
    ok("늦은 A(구토큰) confirm → no-op(false)", (await confirm(db, A, c3.token!)) === false);
    ok("stale confirm 후에도 sent 마킹 0건(B 미확정)", (await sentIds(db, A)).length === 0);

    // ── B confirm(현재 토큰) → cooldown 확정 + 정확히 그 outbox event 만 sent ──
    ok("B(현재 토큰) confirm → true", (await confirm(db, A, bToken!)) === true);
    const sent = await sentIds(db, A);
    ok("confirm 후 sent 마킹 정확히 1건", sent.length === 1);
    ok("confirm 후(cooldown) 재claim → false", (await claim(db, A, SUCCESS)).send === false);

    // ── [P0] 단발 outage + NACK → 새 이벤트 없이 drain due retry → 2xx confirm ──
    const O = "kbo-scoreboard-linescore-outage";
    const o1 = await claim(db, O, OUTAGE); // 1건 즉시 outbox+token
    ok("outage 1건 → should_send=true", o1.send === true);
    ok("outage NACK(전송 실패) → true(현재 토큰)", (await nack(db, O, o1.token!, 60)) === true);
    // 새 열화 이벤트 없음. backoff 지나 due 로 만들고 drain 이 재획득해야 함.
    await db.exec(
      "update public.api_fallback_alert_state set next_attempt_at = now() - interval '1 second' where api_name='kbo-scoreboard-linescore-outage'",
    );
    const oDrain = await drain(db);
    ok("NACK 후 새 이벤트 없이 drain 이 outage outbox 재획득", oDrain.some((x) => x.api_name === O));
    const oTok2 = oDrain.find((x) => x.api_name === O)?.attempt_token;
    ok("재획득 토큰이 최초와 다름", !!oTok2 && oTok2 !== o1.token);
    ok("outage 재전송 2xx confirm → true", (await confirm(db, O, oTok2!)) === true);
    ok("outage 이벤트는 1건인데 outbox 유지되어 재시도됨", (await eventCount(db, O)) === 1);
    ok("outage confirm 후 sent 정확히 1건", (await sentIds(db, O)).length === 1);

    // ── stale NACK no-op ──
    ok("stale 토큰 NACK → no-op(false)", (await nack(db, O, o1.token!, 60)) === false);

    // ── give-up: 최대 수명 초과 outbox 는 drain 이 폐기 ──
    const G = "giveup-api";
    const g1 = await claim(db, G, OUTAGE);
    ok("giveup outbox 생성", g1.send === true);
    await db.exec(
      "update public.api_fallback_alert_state set pending_since = now() - interval '3 hours', next_attempt_at = now() - interval '1 second', locked_until = now() - interval '1 second' where api_name='giveup-api'",
    );
    const gDrain = await drain(db, 120, 120, 20);
    ok("최대 수명 초과 outbox 는 drain 이 재전송 안 함(폐기)", !gDrain.some((x) => x.api_name === G));
    {
      const r = await db.query<{ c: number | string }>(
        "select count(*)::int as c from public.api_fallback_alert_state where api_name='giveup-api' and pending_event_id is not null",
      );
      ok("give-up 후 outbox 제거됨", Number(r.rows[0]?.c) === 0);
    }

    // ── window 밖 과거 이벤트 제외 ──
    const W = "window-test-api";
    await db.exec(
      `insert into public.api_fallback_events(api_name, reason, timestamp) values
       ('window-test-api','schema-error', now() - interval '10 minutes'),
       ('window-test-api','schema-error', now() - interval '9 minutes')`,
    );
    ok("window 밖 과거 이벤트 임계 제외", (await claim(db, W, SUCCESS)).send === false);

    // ── 입력 방어 ──
    let t1 = false;
    try { await claim(db, "bad", { win: 5, thr: 0, cd: 5, lease: 120 }); } catch { t1 = true; }
    ok("threshold<1 → 예외", t1);
    let t2 = false;
    try { await claim(db, "", SUCCESS); } catch { t2 = true; }
    ok("api_name 빈값 → 예외", t2);
    let t3 = false;
    try { await claim(db, "bad2", { win: 5, thr: 3, cd: 5, lease: 0 }); } catch { t3 = true; }
    ok("lease_seconds<1 → 예외", t3);

    // ── RLS/권한 deny ──
    const relPriv = async (role: string, priv: string) => {
      const r = await db.query<{ ok: boolean }>(
        "select has_table_privilege($1,'public.api_fallback_alert_state',$2) as ok",
        [role, priv],
      );
      return r.rows[0]?.ok === true;
    };
    ok("anon SELECT 차단", (await relPriv("anon", "SELECT")) === false);
    ok("authenticated UPDATE 차단", (await relPriv("authenticated", "UPDATE")) === false);
    const fnPriv = async (role: string, sig: string) => {
      const r = await db.query<{ ok: boolean }>(
        "select has_function_privilege($1,$2,'EXECUTE') as ok",
        [role, sig],
      );
      return r.rows[0]?.ok === true;
    };
    ok(
      "anon claim RPC 차단",
      (await fnPriv("anon", "public.claim_api_fallback_alert(text,text,int,text,int,int,int,int,text)")) === false,
    );
    ok(
      "anon record_api_fallback_bucket RPC 차단",
      (await fnPriv("anon", "public.record_api_fallback_bucket(text,text,int,text,text)")) === false,
    );

    // ── fail-close: 옛 8-인자 claim 시그니처가 남아 있으면 scope 미전달 호출이 조용히
    //    즌 경로로 떨어져 폴링 증폭이 계속되는데 아무도 모른다. migration 이 drop 했는지 고정한다.
    {
      const r = await db.query<{ c: number | string }>(
        `select count(*)::int as c
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname = 'claim_api_fallback_alert'
            and p.pronargs = 8`,
      );
      ok("옛 8-인자 claim 시그니처 제거됨(fail-close)", Number(r.rows[0]?.c) === 0);
    }
    {
      const r = await db.query<{ c: number | string }>(
        `select count(*)::int as c
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname = 'claim_api_fallback_alert'
            and p.pronargs = 9`,
      );
      ok("신규 9-인자 claim 시그니처 존재", Number(r.rows[0]?.c) === 1);
    }

    // ── 폴링 증폭 차단: 같은 (api, reason, scope, 1분버킷) 은 1행 + count 증가 ──
    // 2026-08-20 사고 축: 라이브 경기 중 같은 gameId 가 52,297행을 만들었다.
    {
      const B = "bucket-api";
      for (let i = 0; i < 50; i++) {
        await db.query("select public.record_api_fallback_bucket($1,'schema-error',null,'x',$2)", [
          B,
          "20260819HTHH0",
        ]);
      }
      ok("같은 scope 50회 → DB 1행", (await rowCount(db, B)) === 1);
      ok("같은 scope 50회 → 발생 횟수 50 보존", (await occurrenceCount(db, B)) === 50);

      // scope 가 다르면 별도 행(경기별 분리 관측이 죽지 않음)
      await db.query("select public.record_api_fallback_bucket($1,'schema-error',null,'x',$2)", [
        B,
        "20260819SKSS0",
      ]);
      ok("다른 scope → 별도 행", (await rowCount(db, B)) === 2);

      // reason 이 다르면 별도 행(실패 종류 분리 계측 보존)
      await db.query("select public.record_api_fallback_bucket($1,'timeout',null,'x',$2)", [
        B,
        "20260819HTHH0",
      ]);
      ok("다른 reason → 별도 행", (await rowCount(db, B)) === 3);

      // scope 가 null 이어도 동일 버킷으로 묶인다(coalesce(scope,'')).
      const N = "bucket-null-scope";
      for (let i = 0; i < 10; i++) {
        await db.query("select public.record_api_fallback_bucket($1,'timeout',null,'x',null)", [N]);
      }
      ok("scope null 10회 → DB 1행", (await rowCount(db, N)) === 1);
      ok("scope null 10회 → 발생 횟수 10", (await occurrenceCount(db, N)) === 10);
    }

    // ── 임계치가 버킷링 때문에 헐거워지지 않는다(sum(event_count) 판정) ──
    // 이게 이 PR 의 핵심 위험이다: row 로 세면 같은 scope 가 몇 번 터져도 영원히 1행이라
    // 임계치 3에 도달하지 못해 **경보가 영원히 안 나간다**.
    {
      const T = "threshold-same-scope";
      const c1 = await claim(db, T, SUCCESS, "e", "same-game");
      ok("같은 scope 1회차 → 미달", c1.send === false);
      const c2 = await claim(db, T, SUCCESS, "e", "same-game");
      ok("같은 scope 2회차 → 미달", c2.send === false);
      const c3s = await claim(db, T, SUCCESS, "e", "same-game");
      ok("같은 scope 3회차 → 임계 도달(should_send=true)", c3s.send === true);
      ok("그런데 DB 는 1행만(증폭 차단)", (await rowCount(db, T)) === 1);
      ok("발생 횟수는 3 보존", (await occurrenceCount(db, T)) === 3);
      ok("confirm 은 그 버킷 행에 귀속", (await confirm(db, T, c3s.token!)) === true);
      ok("confirm 후 sent 정확히 1행", (await sentIds(db, T)).length === 1);
    }

    // ── 마이그레이션 이전 행(bucket_start null) 호환 ──
    // ⚠️ 실측 정정: `add column event_count int not null default 1` 은 기존 행을 **1로 백필**한다.
    //    따라서 과거 행의 event_count 는 null 이 아니라 1 이다(코드의 coalesce 는 방어적 잉여).
    //    진짜 구분자는 bucket_start 가 null 이라는 점 — 그래서 unique 부분인덱스 밖이고
    //    대량 UPDATE 없이 그대로 공존한다.
    {
      const L = "legacy-rows-api";
      await db.exec(
        `insert into public.api_fallback_events(api_name, reason, timestamp, bucket_start) values
         ('legacy-rows-api','schema-error', now(), null),
         ('legacy-rows-api','schema-error', now(), null)`,
      );
      ok("과거 행은 event_count=1 로 백필됨", (await occurrenceCount(db, L)) === 2);
      {
        const r = await db.query<{ c: number | string }>(
          "select count(*)::int as c from public.api_fallback_events where api_name='legacy-rows-api' and bucket_start is null and event_count = 1",
        );
        ok("과거 행은 bucket_start null 로 남음(unique 부분인덱스 밖)", Number(r.rows[0]?.c) === 2);
      }
      // 과거 행 2건 + 신규 1건 = 3 → 임계 도달. 과거 행이 임계 판정에서 누락되면 false 가 된다.
      ok("과거 행도 임계 판정에 합산됨", (await claim(db, L, SUCCESS, "e", "g1")).send === true);
      // 과거 행은 unique 부분인덱스 밖(bucket_start null)이라 중복 insert 가 막히지 않는다 — 의도.
      ok("과거 행 2개가 그대로 공존(대량 UPDATE 안 함)", (await rowCount(db, L)) === 3);
    }
    ok(
      "anon drain RPC 차단",
      (await fnPriv("anon", "public.drain_api_fallback_alerts(int,int,int)")) === false,
    );
    ok(
      "authenticated confirm RPC 차단",
      (await fnPriv("authenticated", "public.confirm_api_fallback_alert(text,uuid)")) === false,
    );
    ok(
      "authenticated nack RPC 차단",
      (await fnPriv("authenticated", "public.nack_api_fallback_alert(text,uuid,int)")) === false,
    );
  } finally {
    await db.close();
  }

  console.log(`\napi-fallback alert outbox: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
