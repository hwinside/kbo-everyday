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

/**
 * 신규 경로: 버퍼가 모은 delta batch 를 1회 flush 한다.
 * scope/fingerprint/count 를 명시적으로 실어 보낸다.
 */
async function flush(
  db: PGlite,
  events: Array<{
    api: string;
    p: Policy;
    reason?: string;
    errMsg?: string | null;
    scope?: string | null;
    fingerprint?: string | null;
    count?: number;
    claim?: boolean;
  }>,
): Promise<Array<{ api_name: string; attempt_token: string; scope: string | null }>> {
  const payload = events.map((e) => ({
    api_name: e.api,
    reason: e.reason ?? "schema-error",
    status_code: null,
    error_message: e.errMsg === undefined ? "test" : e.errMsg,
    scope: e.scope ?? null,
    fingerprint: e.fingerprint ?? null,
    count: e.count ?? 1,
    window_minutes: e.p.win,
    threshold: e.p.thr,
    cooldown_minutes: e.p.cd,
    lease_seconds: e.p.lease,
    // 기본은 경보 claim 대상(기존 durable 경보 경로 재현). record-only 는 명시적으로 false.
    claim: e.claim ?? true,
  }));
  const r = await db.query<{ api_name: string; attempt_token: string; scope: string | null }>(
    "select out_api_name as api_name, out_attempt_token as attempt_token, out_scope as scope from public.flush_api_fallback_buckets($1::jsonb)",
    [JSON.stringify(payload)],
  );
  return r.rows;
}

/**
 * 구버전 8-인자 경로(EXPAND 단계 wrapper). 배포 순서 어느 쪽이든 동작해야 한다.
 * 시그니처를 drop 하지 않았으므로 이 호출이 살아있는지가 blocker 2 의 핵심 계약이다.
 */
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

/** 버킷 행 수(= 저장된 행). 폴링 증폭 차단 여부는 이 값으로 본다. */
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
      (await fnPriv("anon", "public.claim_api_fallback_alert(text,text,int,text,int,int,int,int)")) === false,
    );
    ok(
      "anon flush_api_fallback_buckets RPC 차단",
      (await fnPriv("anon", "public.flush_api_fallback_buckets(jsonb)")) === false,
    );
    ok(
      "anon summarize_api_fallbacks RPC 차단",
      (await fnPriv("anon", "public.summarize_api_fallbacks(timestamptz,timestamptz,text)")) === false,
    );

    // ── EXPAND 계약(삼순 blocker 2): 옛 8-인자 claim 을 **살려둔다** ──
    //
    // 1차엔 이걸 drop 해놓고 "fail-close"라 불렀는데, 그러면 `migration→배포` 순서에서
    // 구버전 인스턴스가 없는 RPC 를 부르게 된다(반대 순서도 대칭적으로 깨짐).
    // 제거는 앱 배포 + old deployment drain 확인 후 별도 contract migration 의 일이다.
    {
      const r = await db.query<{ c: number | string }>(
        `select count(*)::int as c
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname = 'claim_api_fallback_alert'
            and p.pronargs = 8`,
      );
      ok("EXPAND: 옛 8-인자 claim 이 wrapper 로 보존됨", Number(r.rows[0]?.c) === 1);
    }
    {
      // ⚠️ "8-인자가 존재하는가"만으로는 부족하다 — 그 시그니처는 20260729 migration 에도
      //    있으므로 이번 wrapper 를 통째로 지워도 **존재 검사는 통과**한다(관측 불가능한 계약).
      //    진짜 계약은 "구버전 호출도 신규 버킷 경로를 탄다"이다. 그래야 배포 순서가
      //    `migration→앱` 이어도 구버전 인스턴스의 쓰기가 증폭되지 않는다.
      const W = "expand-wrapper-api";
      await claim(db, W, SUCCESS, "legacy-call");
      const r = await db.query<{ bucketed: number | string; total: number | string }>(
        `select count(*) filter (where bucket_start is not null)::int as bucketed,
                count(*)::int as total
           from public.api_fallback_events where api_name = $1`,
        [W],
      );
      ok("EXPAND: 구버전 8-인자 호출도 신규 버킷 경로를 탄다", Number(r.rows[0]?.bucketed) === 1);
      ok("EXPAND: 구버전 호출이 이중 기록하지 않는다", Number(r.rows[0]?.total) === 1);

      // 구버전 호출을 반복해도 같은 버킷에 합산된다(증폭 차단이 구버전에도 적용).
      await claim(db, W, SUCCESS, "legacy-call");
      await claim(db, W, SUCCESS, "legacy-call");
      ok("EXPAND: 구버전 반복 호출도 1행으로 합산", (await rowCount(db, W)) === 1);
      ok("EXPAND: 구버전 발생 횟수 3 보존", (await occurrenceCount(db, W)) === 3);
    }
    {
      const r = await db.query<{ c: number | string }>(
        `select count(*)::int as c
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname = 'flush_api_fallback_buckets'`,
      );
      ok("신규 batch flush RPC 존재", Number(r.rows[0]?.c) === 1);
    }

    // ── 폴링 증폭 차단: 같은 (api, reason, scope, fingerprint, 1분버킷) 은 1행 + count ──
    // 2026-08-20 사고 축: 라이브 경기 중 같은 gameId 가 52,297행을 만들었다.
    //
    // ⚠️ 삼순 blocker 1: 이전 게이트는 `rowCount = DB 쓰기량` 을 전제했는데 틀렸다.
    //    UPSERT 도 write 다. 쓰기 **횟수**는 앱 단 버퍼(qa:fallback-buffer)가 책임지고,
    //    여기서는 "batch 1회 호출이 몇 행을 남기는가"만 검증한다.
    {
      const B = "bucket-api";
      // 버퍼가 50건을 모아 count=50 으로 1회 flush 한 상황
      await flush(db, [{ api: B, p: SUCCESS, scope: "20260819HTHH0", count: 50 }]);
      ok("batch 1회(count=50) → DB 1행", (await rowCount(db, B)) === 1);
      ok("발생 횟수 50 보존", (await occurrenceCount(db, B)) === 50);

      // 같은 버킷에 다시 flush 되면 누적된다(주기 flush 재현)
      await flush(db, [{ api: B, p: SUCCESS, scope: "20260819HTHH0", count: 7 }]);
      ok("같은 버킷 재-flush → 여전히 1행", (await rowCount(db, B)) === 1);
      ok("누적 합산 57", (await occurrenceCount(db, B)) === 57);

      // scope 가 다르면 별도 행(경기별 분리 관측이 죽지 않음)
      await flush(db, [{ api: B, p: SUCCESS, scope: "20260819SKSS0" }]);
      ok("다른 scope → 별도 행", (await rowCount(db, B)) === 2);

      // reason 이 다르면 별도 행(실패 종류 분리 계측 보존)
      await flush(db, [{ api: B, p: SUCCESS, reason: "timeout", scope: "20260819HTHH0" }]);
      ok("다른 reason → 별도 행", (await rowCount(db, B)) === 3);

      // fingerprint 가 다르면 별도 행 — 삼순 blocker 4:
      // coarse reason 만 키로 쓰면 같은 분의 서로 다른 오류가 마지막 메시지 하나로 합쳐진다.
      await flush(db, [
        { api: B, p: SUCCESS, scope: "20260819HTHH0", fingerprint: "aaaa1111", errMsg: "conn reset" },
      ]);
      await flush(db, [
        { api: B, p: SUCCESS, scope: "20260819HTHH0", fingerprint: "bbbb2222", errMsg: "bad inning" },
      ]);
      ok("다른 fingerprint → 별도 행(오류 뭉갬 방지)", (await rowCount(db, B)) === 5);
      {
        const r = await db.query<{ c: number | string }>(
          "select count(*)::int as c from public.api_fallback_events where api_name=$1 and error_message in ('conn reset','bad inning')",
          [B],
        );
        ok("두 오류 메시지가 각각 보존됨", Number(r.rows[0]?.c) === 2);
      }

      // scope 가 null 이어도 동일 버킷으로 묶인다(coalesce(scope,'')).
      const N = "bucket-null-scope";
      await flush(db, [{ api: N, p: SUCCESS, reason: "timeout", scope: null, count: 10 }]);
      ok("scope null → DB 1행", (await rowCount(db, N)) === 1);
      ok("scope null 발생 횟수 10", (await occurrenceCount(db, N)) === 10);
    }

    // ── batch 안에 여러 api 가 섞여도 각각 판정된다 ──
    {
      const X = "multi-a";
      const Y = "multi-b";
      const rows = await flush(db, [
        { api: X, p: OUTAGE, scope: "g1" },
        { api: Y, p: OUTAGE, scope: "g2" },
      ]);
      ok("batch 1회로 두 api 모두 임계 도달", rows.length === 2);
      ok("각 api 당 토큰 1개", new Set(rows.map((r) => r.api_name)).size === 2);
    }

    // ── 임계치가 버킷링 때문에 헐거워지지 않는다(sum(event_count) 판정) ──
    // 이게 이 PR 의 핵심 위험이다: row 로 세면 같은 scope 가 몇 번 터져도 영원히 1행이라
    // 임계치 3에 도달하지 못해 **경보가 영원히 안 나간다**.
    {
      const T = "threshold-same-scope";
      const rows = await flush(db, [{ api: T, p: SUCCESS, scope: "same-game", count: 3 }]);
      ok("같은 scope count=3 → 임계 도달(토큰 발급)", rows.length === 1);
      ok("그런데 DB 는 1행만(증폭 차단)", (await rowCount(db, T)) === 1);
      ok("발생 횟수는 3 보존", (await occurrenceCount(db, T)) === 3);
      ok("confirm 은 그 버킷 행에 귀속", (await confirm(db, T, rows[0].attempt_token)) === true);
      ok("confirm 후 sent 정확히 1행", (await sentIds(db, T)).length === 1);
    }
    {
      // 반대 방향: count 가 임계 미달이면 경보가 나가지 않는다.
      const U = "threshold-under";
      const rows = await flush(db, [{ api: U, p: SUCCESS, scope: "g", count: 2 }]);
      ok("count=2 (임계 3) → 경보 없음", rows.length === 0);
      ok("그래도 이벤트는 durable 로 남음", (await occurrenceCount(db, U)) === 2);
    }

    // ── 서버 집계 RPC (삼순 blocker 3: 무페이지 select 가 1,000행 cap 에 잘리던 문제) ──
    {
      const S = "summary-api";
      await flush(db, [{ api: S, p: SUCCESS, scope: "g1", count: 1000 }]);
      await flush(db, [{ api: S, p: SUCCESS, reason: "timeout", scope: "g2", count: 500 }]);
      const r = await db.query<{ api_name: string; reason: string; occurrences: string; rows_stored: string }>(
        "select api_name, reason, occurrences, rows_stored from public.summarize_api_fallbacks($1, null, $2)",
        [new Date(Date.now() - 60 * 60 * 1000).toISOString(), S],
      );
      ok("집계 RPC 가 reason 별로 묶어 반환", r.rows.length === 2);
      const total = r.rows.reduce((n, x) => n + Number(x.occurrences), 0);
      ok(`집계 occurrences = 1500 (실측 ${total})`, total === 1500);
      const stored = r.rows.reduce((n, x) => n + Number(x.rows_stored), 0);
      ok(`저장 행은 2행뿐 (실측 ${stored})`, stored === 2);
      // 핵심: 1,500건을 보고하려고 1,500행을 클라이언트로 가져오지 않는다.
      ok("반환 행 수가 발생 횟수와 무관하게 작다(cap 회피)", r.rows.length < 10);
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
      ok("과거 행도 임계 판정에 합산됨", (await claim(db, L, SUCCESS, "e")).send === true);
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
