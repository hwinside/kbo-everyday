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
): Promise<{ send: boolean; token: string | null }> {
  const r = await db.query<{ should_send: boolean; attempt_token: string | null }>(
    "select should_send, attempt_token from public.claim_api_fallback_alert($1,'schema-error',null,$2,$3,$4,$5,$6)",
    [api, errMsg, p.win, p.thr, p.cd, p.lease],
  );
  return { send: r.rows[0]?.should_send === true, token: r.rows[0]?.attempt_token ?? null };
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
async function eventCount(db: PGlite, api: string): Promise<number> {
  const r = await db.query<{ c: number | string }>(
    "select count(*)::int as c from public.api_fallback_events where api_name=$1",
    [api],
  );
  return Number(r.rows[0]?.c ?? 0);
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
      (await fnPriv("anon", "public.claim_api_fallback_alert(text,text,int,text,int,int,int,int)")) === false,
    );
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
