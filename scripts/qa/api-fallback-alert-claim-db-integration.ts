/**
 * API 열화 durable 감지·경보 claim DB 통합 테스트 (PGlite 격리 Postgres).
 * 20260729_api_fallback_alert_claim.sql 의 record_api_fallback_and_claim RPC 를 실제 적용해,
 * 서버리스 인스턴스 분산에도 "임계치 초과 시 경보 1회"가 durable/원자적으로 보장되는지 검증한다.
 * 삼순 NO-GO(in-memory count → 분산 시 감지 실패) 반영의 실회귀.
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

// success 정책(5분 3회, cooldown 30분), outage 정책(5분 1회, cooldown 10분)
async function claim(
  db: PGlite,
  api: string,
  policy: { win: number; thr: number; cd: number },
  errMsg = "test",
): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(
    "select public.record_api_fallback_and_claim($1,'schema-error',null,$2,$3,$4,$5) as ok",
    [api, errMsg, policy.win, policy.thr, policy.cd],
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
    `);
    // RLS 없이(격리 PGlite) 테이블 + RPC 만 적용. 원본 마이그레이션은 RLS 포함이라
    // api_fallback_events 스키마만 최소 재현 후 claim 마이그레이션 적용.
    await db.exec(`
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

    const SUCCESS = { win: 5, thr: 3, cd: 30 };
    const OUTAGE = { win: 5, thr: 1, cd: 10 };

    // ── 분산 3요청(3 insert) → 경보 정확히 1회 ──
    const A = "kbo-scoreboard-linescore";
    ok("1번째 열화 → count<임계 → 경보 안 함", (await claim(db, A, SUCCESS)) === false);
    ok("2번째 열화 → 여전히 count<임계 → 경보 안 함", (await claim(db, A, SUCCESS)) === false);
    ok("3번째 열화 → 임계 도달 → 경보 1회", (await claim(db, A, SUCCESS)) === true);
    ok("4번째(cooldown 중) → 경보 0회", (await claim(db, A, SUCCESS)) === false);
    ok("5번째(cooldown 중) → 경보 0회", (await claim(db, A, SUCCESS)) === false);
    ok("이벤트는 5건 모두 durable 기록됨", (await eventCount(db, A)) === 5);
    {
      const r = await db.query<{ c: number | string }>(
        "select count(*)::int as c from public.api_fallback_events where api_name=$1 and alert_sent=true",
        [A],
      );
      ok("alert_sent=true 로 마킹된 이벤트는 정확히 1건", Number(r.rows[0]?.c) === 1);
    }

    // ── cooldown 경과 후 재임계 → 다시 1회 ──
    await db.exec(
      "update public.api_fallback_alert_state set last_alerted_at = now() - interval '31 minutes' where api_name = 'kbo-scoreboard-linescore'",
    );
    ok("cooldown 경과 후 임계 재도달 → 경보 재발", (await claim(db, A, SUCCESS)) === true);
    ok("직후 재호출 → 다시 cooldown → 0회", (await claim(db, A, SUCCESS)) === false);

    // ── window 밖 오래된 이벤트는 count 에서 제외 ──
    const B = "window-test-api";
    await db.exec(
      `insert into public.api_fallback_events(api_name, reason, timestamp) values
       ('window-test-api','schema-error', now() - interval '10 minutes'),
       ('window-test-api','schema-error', now() - interval '9 minutes')`,
    );
    // 위 2건은 5분 window 밖 → 지금 1건 추가해도 window 내 count=1 < 3 → 경보 안 함
    ok("window 밖 과거 이벤트는 임계 count 제외", (await claim(db, B, SUCCESS)) === false);

    // ── outage 정책: 1건 즉시 경보 ──
    const C = "kbo-scoreboard-linescore-outage";
    ok("outage 1건 → 즉시 경보", (await claim(db, C, OUTAGE)) === true);
    ok("outage 직후 재발(cooldown 중) → 0회", (await claim(db, C, OUTAGE)) === false);
    await db.exec(
      "update public.api_fallback_alert_state set last_alerted_at = now() - interval '11 minutes' where api_name = 'kbo-scoreboard-linescore-outage'",
    );
    ok("outage cooldown(10분) 경과 → 재경보", (await claim(db, C, OUTAGE)) === true);

    // ── 서로 다른 api_name 은 독립 임계/쿨다운 ──
    ok("다른 api_name 은 독립 카운트(success 3회째 아직 아님)", (await claim(db, "other-api", SUCCESS)) === false);

    // ── 입력 방어: threshold<1 은 예외 ──
    let threw = false;
    try {
      await claim(db, "bad", { win: 5, thr: 0, cd: 5 });
    } catch {
      threw = true;
    }
    ok("threshold<1 → 예외(방어)", threw);

    // ── 방어: api_name 빈값 예외 ──
    let threw2 = false;
    try {
      await claim(db, "", SUCCESS);
    } catch {
      threw2 = true;
    }
    ok("api_name 빈값 → 예외(방어)", threw2);
  } finally {
    await db.close();
  }

  console.log(`\napi-fallback alert claim: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
