/**
 * API 열화 durable 경보 claim/confirm(outbox·lease·2xx ACK) DB 통합 테스트 (PGlite 격리 Postgres).
 * 20260729_api_fallback_alert_claim.sql 의 claim_api_fallback_alert / confirm_api_fallback_alert 를
 * 실제 적용해, "실제 전송(2xx) 후에만 cooldown 확정" + "전송 실패 시 lease 만료로 재시도" +
 * "인스턴스 분산에도 경보 1회"의 결정론적 로직을 검증한다. (advisory-lock race 는 별도 PG17 harness)
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

async function claim(db: PGlite, api: string, p: Policy, errMsg = "test"): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(
    "select public.claim_api_fallback_alert($1,'schema-error',null,$2,$3,$4,$5,$6) as ok",
    [api, errMsg, p.win, p.thr, p.cd, p.lease],
  );
  return r.rows[0]?.ok === true;
}
async function confirm(db: PGlite, api: string): Promise<void> {
  await db.query("select public.confirm_api_fallback_alert($1)", [api]);
}
async function eventCount(db: PGlite, api: string): Promise<number> {
  const r = await db.query<{ c: number | string }>(
    "select count(*)::int as c from public.api_fallback_events where api_name=$1",
    [api],
  );
  return Number(r.rows[0]?.c ?? 0);
}
async function sentCount(db: PGlite, api: string): Promise<number> {
  const r = await db.query<{ c: number | string }>(
    "select count(*)::int as c from public.api_fallback_events where api_name=$1 and alert_sent=true",
    [api],
  );
  return Number(r.rows[0]?.c ?? 0);
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
    ok("1번째 열화 → count<임계 → should_send=false", (await claim(db, A, SUCCESS)) === false);
    ok("2번째 열화 → 여전히 미달 → false", (await claim(db, A, SUCCESS)) === false);

    // ── 3번째 임계 도달 → should_send=true (아직 cooldown 확정 아님) ──
    ok("3번째 → 임계 도달 → should_send=true", (await claim(db, A, SUCCESS)) === true);
    ok("이벤트 3건 durable 기록", (await eventCount(db, A)) === 3);
    ok("아직 confirm 전 → alert_sent 마킹 0건", (await sentCount(db, A)) === 0);

    // ── [핵심] confirm 전(전송 미완료)엔 lease 로 중복 전송 차단 ──
    ok("confirm 전 재claim → lease 유효 → false(중복 전송 방지)", (await claim(db, A, SUCCESS)) === false);

    // ── 전송 2xx 후 confirm → cooldown 확정 + alert_sent 마킹 ──
    await confirm(db, A);
    ok("confirm 후 alert_sent 정확히 1건", (await sentCount(db, A)) === 1);
    ok("confirm 후(cooldown 중) 재claim → false", (await claim(db, A, SUCCESS)) === false);

    // ── [핵심] 전송 실패(confirm 없음) → lease 만료 후 재claim 가능(재시도) ──
    // cooldown 은 아직 안 걸린 상태를 만들기 위해 last_alerted_at 을 비우고 lease 만 과거로.
    await db.exec(
      "update public.api_fallback_alert_state set last_alerted_at=null, pending_lease_at = now() - interval '3 minutes' where api_name='kbo-scoreboard-linescore'",
    );
    ok("전송 실패 후 lease(120s) 만료 → 재claim true(재시도)", (await claim(db, A, SUCCESS)) === true);
    // 이번엔 confirm 안 하고 lease 활성 → 재claim false
    ok("재시도 claim 직후 lease 활성 → false", (await claim(db, A, SUCCESS)) === false);

    // ── cooldown 경과 후 재임계 → 다시 true ──
    await db.exec(
      "update public.api_fallback_alert_state set last_alerted_at = now() - interval '31 minutes', pending_lease_at = now() - interval '3 minutes' where api_name='kbo-scoreboard-linescore'",
    );
    ok("cooldown(30분) 경과 → 재claim true", (await claim(db, A, SUCCESS)) === true);

    // ── window 밖 과거 이벤트는 임계 count 제외 ──
    const B = "window-test-api";
    await db.exec(
      `insert into public.api_fallback_events(api_name, reason, timestamp) values
       ('window-test-api','schema-error', now() - interval '10 minutes'),
       ('window-test-api','schema-error', now() - interval '9 minutes')`,
    );
    ok("window 밖 과거 이벤트는 임계 제외", (await claim(db, B, SUCCESS)) === false);

    // ── outage 정책: 1건 즉시 true ──
    const C = "kbo-scoreboard-linescore-outage";
    ok("outage 1건 → 즉시 should_send=true", (await claim(db, C, OUTAGE)) === true);
    ok("outage confirm 전 재claim → lease → false", (await claim(db, C, OUTAGE)) === false);
    await confirm(db, C);
    ok("outage confirm 후(cooldown) → false", (await claim(db, C, OUTAGE)) === false);
    await db.exec(
      "update public.api_fallback_alert_state set last_alerted_at = now() - interval '11 minutes' where api_name='kbo-scoreboard-linescore-outage'",
    );
    ok("outage cooldown(10분) 경과 → 재claim true", (await claim(db, C, OUTAGE)) === true);

    // ── 서로 다른 api_name 은 독립 ──
    ok("다른 api_name 은 독립 카운트(3회째 아님)", (await claim(db, "other-api", SUCCESS)) === false);

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

    // ── RLS/권한: anon/authenticated 직접 접근·RPC 실행 차단 ──
    const relPriv = async (role: string, priv: string) => {
      const r = await db.query<{ ok: boolean }>(
        "select has_table_privilege($1,'public.api_fallback_alert_state',$2) as ok",
        [role, priv],
      );
      return r.rows[0]?.ok === true;
    };
    ok("anon SELECT 차단", (await relPriv("anon", "SELECT")) === false);
    ok("anon INSERT 차단", (await relPriv("anon", "INSERT")) === false);
    ok("authenticated UPDATE 차단", (await relPriv("authenticated", "UPDATE")) === false);
    const fnPriv = async (role: string, sig: string) => {
      const r = await db.query<{ ok: boolean }>(
        "select has_function_privilege($1,$2,'EXECUTE') as ok",
        [role, sig],
      );
      return r.rows[0]?.ok === true;
    };
    ok(
      "anon claim RPC 실행 차단",
      (await fnPriv("anon", "public.claim_api_fallback_alert(text,text,int,text,int,int,int,int)")) === false,
    );
    ok(
      "authenticated confirm RPC 실행 차단",
      (await fnPriv("authenticated", "public.confirm_api_fallback_alert(text)")) === false,
    );
  } finally {
    await db.close();
  }

  console.log(`\napi-fallback alert claim/confirm: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
