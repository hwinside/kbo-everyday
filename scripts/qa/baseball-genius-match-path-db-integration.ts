import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const readMigration = (name: string) => readFileSync(
  path.join(process.cwd(), "supabase/migrations", name),
  "utf8",
);

async function main() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.genius_question_logs (
      match_path text not null,
      constraint genius_question_logs_match_path_check check (
        match_path in (
          'dictionary','cache','llm','service_redirect','history_hold',
          'blocked','unsure','limited','error','context_missing'
        )
      )
    );
    create table public.genius_question_jobs (
      message_id bigint primary key,
      user_id uuid not null,
      status text not null constraint genius_question_jobs_status_check
        check (status in ('queued','processing','ready','completed','failed')),
      lease_until timestamptz not null default now(),
      answer text,
      source text,
      remaining integer,
      quota_reserved boolean not null default false,
      quota_allowed boolean,
      quota_remaining integer,
      attempts integer not null default 0,
      delivery_attempts integer not null default 0,
      last_error text,
      updated_at timestamptz not null default now()
    );
    create table public.genius_daily_usage (
      user_id uuid not null,
      kst_day date not null,
      used integer not null,
      updated_at timestamptz not null default now(),
      primary key (user_id, kst_day)
    );
  `);

  // 실제 운영 forward-apply 순서를 그대로 재현한다.
  //
  // ⚠️ 운영 ledger 정본은 `20260804124500_baseball_genius_match_path_union.sql` 이다.
  // 날짜만 있는 구 `20260801_*` 두 파일은 version 이 충돌해 ledger 등록에 실패했고,
  // 그 결과 운영 CHECK 에 `rag` 가 빠진 채 남아 선수 질문 로그 INSERT 가 23514 로
  // 실패했다(2026-08-04 P0). union hotfix 가 두 라벨을 합집합 한 벌로 다시 선언했으므로
  // 여기서도 **union 을 먼저 적용한 뒤** 그보다 뒤 timestamp 인 picker 를 얹는다.
  // 구 개별 파일을 재적용하면 서로가 서로의 라벨을 지우는 순서 의존이 되살아난다.
  await db.exec(readMigration("20260804124500_baseball_genius_match_path_union.sql"));
  await db.exec(readMigration("20260804140000_baseball_genius_player_picker.sql"));
  // 이후 감사 축을 나누며 라벨을 더한 migration 들. **운영 적용 순서 그대로** 얹는다 —
  // 각각이 CHECK 를 통째로 재선언하므로, 하나라도 선행 라벨을 빠뜨리면 아래 전수 INSERT 가
  // 23514 로 RED 가 된다(그게 이 게이트의 존재 이유다).
  await db.exec(readMigration("20260807090000_baseball_genius_team_rag_audit.sql"));
  await db.exec(readMigration("20260808040000_baseball_genius_news_rag_match_path.sql"));
  await db.exec(readMigration("20260808120000_baseball_genius_scope_guide_match_path.sql"));
  await db.exec(readMigration("20260808230000_baseball_genius_name_suggest_match_path.sql"));
  // #1151 정규화 컬럼 — picker migration 이 이 컬럼의 CHECK 를 재선언하므로 선행 필수.
  await db.exec(readMigration("20260811210000_baseball_genius_question_normalized.sql"));
  // #1151 picker — `question_correction` 라벨을 더하며 CHECK 를 재선언한다 (Production 적용분).
  await db.exec(readMigration("20260813203000_baseball_genius_question_correction_picker.sql"));
  // ⚠️ `stat_clarify` 는 현행 최신(`20260813203000`) **뒤** 타임스탬프다. 구 `20260809150000` 은
  //   #1135 기준 union 이라 그 뒤 Production 적용된 `question_correction` 을 누락한 CHECK 로
  //   덮어썼다(삼순 2026-08-14 DB P0 실측). 이 게이트는 그 유형을 잡기 위해 운영 적용 순서
  //   그대로 재현하고 아래 전수 INSERT 로 전 라벨 생존을 검증한다.
  await db.exec(readMigration("20260814215000_baseball_genius_stat_clarify_match_path.sql"));

  await verifyFinalAllowlistIsExactUnion(db);

  const userId = "00000000-0000-4000-8000-000000000001";
  await db.exec(`
    insert into public.genius_question_logs(match_path)
      values ('rag'), ('error'), ('player_picker'), ('kbo_structured');
    insert into public.genius_question_jobs(
      message_id, user_id, status, source, quota_reserved, quota_allowed, quota_remaining, quota_released
    ) values (1, '${userId}', 'awaiting_selection', 'player_picker', true, true, 4, true);
    update public.genius_question_jobs set attempts = 5 where message_id = 1;
    insert into public.genius_daily_usage(user_id, kst_day, used)
      values ('${userId}', (clock_timestamp() at time zone 'Asia/Seoul')::date, 1);
  `);
  const rows = await db.query<{ match_path: string }>(
    "select match_path from public.genius_question_logs order by match_path",
  );
  assert.deepEqual(rows.rows.map((row) => row.match_path), ["error", "kbo_structured", "player_picker", "rag"]);
  const ledger = await db.query<{ source: string }>(
    "select source from public.genius_question_jobs where message_id = 1",
  );
  assert.equal(ledger.rows[0]?.source, "player_picker");
  const prepared = await db.query<{ prepared: boolean }>(
    "select prepare_baseball_genius_player_selection($1,$2,$3) as prepared",
    [1, userId, "69102"],
  );
  assert.equal(prepared.rows[0]?.prepared, true, "picker selection RPC actual");
  const selected = await db.query<{
    status: string; picked_player_kbo_id: string; quota_reserved: boolean; source: string | null; attempts: number;
  }>("select status,picked_player_kbo_id,quota_reserved,source,attempts from genius_question_jobs where message_id=1");
  assert.deepEqual(selected.rows[0], {
    status: "queued", picked_player_kbo_id: "69102", quota_reserved: false, source: null, attempts: 0,
  }, "선택값 persist + 최종답변 quota 재예약 + selection phase attempts reset");
  // picker가 5번째 처리에서 성공하고 prepare 직후 worker가 죽어도 due에 다시 잡혀야 한다.
  const due = await db.query<{ message_id: number }>(
    "select message_id from genius_question_jobs where message_id=1 and status='queued' and attempts < 5 and lease_until <= clock_timestamp()",
  );
  assert.deepEqual(due.rows.map((row) => Number(row.message_id)), [1], "attempts=5 picker selection crash recovery");
  await assert.rejects(
    () => db.exec("insert into public.genius_question_logs(match_path) values ('player_rag')"),
    /check constraint|23514/i,
  );

  await verifyQuotaReleaseUsesReservedDayBucket(db);

  await db.close();

  console.log(
    "PASS genius match_path DB actual — picker migration/CHECK/RPC + rag/kbo_structured ledger + " +
      "미지 경로 거부 + quota 반납이 예약일 버킷을 차감",
  );
}

/**
 * 최종 CHECK 가 **선행 union 전체 + picker 신규 라벨의 합집합**인지 actual 로 고정한다
 * (삼순 6차 P0-1).
 *
 * ⚠️ 종전 게이트는 신규 4라벨(`rag`/`error`/`player_picker`/`kbo_structured`)만 INSERT 했다.
 * 그래서 **후행 migration 이 선행 union 의 라벨을 도로 지워도** 게이트가 전부 GREEN 이었다
 * (삼순이 `ack` 제거 변종으로 재현 — 운영에서는 실 INSERT 23514 로 job 이 죽는다).
 * 이건 2026-08-04 P0 자체와 같은 사고다: allowlist 를 합집합이 아니라 **재선언**으로 다루면
 * 새 migration 이 조용히 과거 라벨을 잃는다.
 *
 * 그래서 세 축으로 닫는다.
 *  ① 허용 라벨을 **전부 실제 INSERT** — 하나라도 빠지면 23514 로 RED
 *  ② 미지 라벨은 거부 — allowlist 가 통째로 열려버리는 반대 방향도 막는다
 *  ③ `pg_get_constraintdef` 로 최종 정의를 직접 읽어 **집합이 정확히 일치**하는지 대조 —
 *     라벨이 더 늘어난 것도 잡는다(의도한 확장이면 이 목록을 같이 고쳐야 한다).
 */
const FINAL_MATCH_PATH_ALLOWLIST = [
  "ack",
  "blocked",
  "cache",
  "context_missing",
  "dictionary",
  "error",
  "history_hold",
  "kbo_structured",
  "limited",
  "llm",
  "name_suggest",
  "news_rag",
  "player_picker",
  "question_correction",
  "rag",
  "scope_guide",
  "service_redirect",
  "stat_clarify",
  "team_rag",
  "unsure",
] as const;

async function verifyFinalAllowlistIsExactUnion(db: PGlite) {
  // ① 전 라벨 actual INSERT. 선행 union 라벨이 후행에서 지워지면 여기서 23514 로 죽는다.
  for (const label of FINAL_MATCH_PATH_ALLOWLIST) {
    await db.query("insert into public.genius_question_logs(match_path) values ($1)", [label]);
  }
  const accepted = await db.query<{ match_path: string }>(
    "select distinct match_path from public.genius_question_logs order by match_path",
  );
  assert.deepEqual(
    accepted.rows.map((row) => row.match_path),
    [...FINAL_MATCH_PATH_ALLOWLIST],
    "최종 CHECK 는 선행 union 전체 + picker 신규 라벨을 모두 허용해야 한다",
  );

  // ② 미지 라벨 거부 — allowlist 가 통째로 열리는 반대 방향.
  for (const unknown of ["player_rag", "llm_scope_gate", "RAG", ""]) {
    await assert.rejects(
      () => db.query("insert into public.genius_question_logs(match_path) values ($1)", [unknown]),
      /check constraint|23514/i,
      `미지 라벨은 거부되어야 한다: ${JSON.stringify(unknown)}`,
    );
  }

  // ③ 최종 정의를 직접 읽어 집합 동일성 대조. INSERT 만으로는 "더 늘어난" 라벨을 못 잡는다.
  const def = await db.query<{ definition: string }>(`
    select pg_get_constraintdef(oid) as definition from pg_constraint
    where conname = 'genius_question_logs_match_path_check'
      and conrelid = 'public.genius_question_logs'::regclass
  `);
  const definition = def.rows[0]?.definition;
  assert.ok(definition, "최종 CHECK 정의를 찾지 못함");
  const declared = [...definition.matchAll(/'([a-z_]*)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    declared,
    [...FINAL_MATCH_PATH_ALLOWLIST],
    `최종 CHECK 라벨 집합이 기대와 다름: ${definition}`,
  );

  // 이 검사만을 위해 넣은 행은 이후 단정에 섞이지 않게 걷어낸다.
  await db.exec("delete from public.genius_question_logs");
}

/**
 * quota 반납은 **예약했던 KST 날짜 버킷**을 차감해야 한다 (삼순 5차 P0-c).
 *
 * 재현 시나리오: 23:59 에 질문해서 어제 버킷을 한 개 썼고(picker 를 받음),
 * 자정을 넘긴 00:01 에 선수를 고른다. 반납이 "지금" 날짜를 깎으면
 *   ① 어제 버킷은 그대로 남아 유저가 어제 한도를 잃고
 *   ② 오늘 버킷이 깎여 유저가 오늘 한도를 공짜로 한 개 얻는다
 * — 양쪽으로 틀린다. 두 버킷을 동시에 놓고 정확히 한 쪽만 줄어드는지 actual 로 본다.
 */
async function verifyQuotaReleaseUsesReservedDayBucket(db: PGlite) {
  const userId = "00000000-0000-4000-8000-0000000000c7";
  await db.exec(`
    insert into public.genius_daily_usage(user_id, kst_day, used) values
      ('${userId}', (clock_timestamp() at time zone 'Asia/Seoul')::date - 1, 3),
      ('${userId}', (clock_timestamp() at time zone 'Asia/Seoul')::date, 7);
    insert into public.genius_question_jobs(
      message_id, user_id, status, source, quota_reserved, quota_allowed, quota_remaining, quota_released
    ) values (777, '${userId}', 'awaiting_selection', 'player_picker', true, true, 17, false);
    update public.genius_question_jobs
      set quota_kst_day = (clock_timestamp() at time zone 'Asia/Seoul')::date - 1
      where message_id = 777;
  `);

  const released = await db.query<{ released: number }>(
    "select release_baseball_genius_daily_question_for_message($1,$2) as released",
    [777, userId],
  );
  assert.equal(Number(released.rows[0]?.released), 1, "예약된 job 은 1회 반납된다");

  const buckets = await db.query<{ offset_days: number; used: number }>(`
    select (kst_day - (clock_timestamp() at time zone 'Asia/Seoul')::date) as offset_days, used
    from public.genius_daily_usage where user_id = $1 order by kst_day
  `, [userId]);
  assert.deepEqual(
    buckets.rows.map((row) => [Number(row.offset_days), Number(row.used)]),
    [[-1, 2], [0, 7]],
    "예약일(어제) 버킷만 3→2 로 줄고 오늘 버킷 7 은 불변이어야 한다",
  );

  // 멱등: 재호출은 아무 버킷도 건드리지 않는다.
  const again = await db.query<{ released: number }>(
    "select release_baseball_genius_daily_question_for_message($1,$2) as released",
    [777, userId],
  );
  assert.equal(Number(again.rows[0]?.released), 0, "반납은 message_id 당 정확히 1회");
  const afterReplay = await db.query<{ offset_days: number; used: number }>(`
    select (kst_day - (clock_timestamp() at time zone 'Asia/Seoul')::date) as offset_days, used
    from public.genius_daily_usage where user_id = $1 order by kst_day
  `, [userId]);
  assert.deepEqual(
    afterReplay.rows.map((row) => [Number(row.offset_days), Number(row.used)]),
    [[-1, 2], [0, 7]],
    "재호출에도 버킷 불변",
  );

  // prepare 는 반납 끝난 예약의 날짜 귀속도 같이 비운다(오래된 날짜 잔류 금지).
  await db.query("select prepare_baseball_genius_player_selection($1,$2,$3)", [777, userId, "69102"]);
  const afterPrepare = await db.query<{ quota_kst_day: string | null; quota_reserved: boolean }>(
    "select quota_kst_day, quota_reserved from public.genius_question_jobs where message_id = 777",
  );
  assert.equal(afterPrepare.rows[0]?.quota_kst_day, null, "반납 끝난 예약은 날짜 귀속도 비운다");
  assert.equal(afterPrepare.rows[0]?.quota_reserved, false, "최종답변용 예약이 새로 열린다");

  // 예약 RPC 가 날짜를 실제로 기록하는지 — 이게 없으면 위 계약이 운영에서 무의미하다.
  const reserved = await db.query<{ allowed: boolean; remaining: number }>(
    "select * from reserve_baseball_genius_daily_question_for_message($1,$2,$3)",
    [777, userId, 20],
  );
  assert.equal(reserved.rows[0]?.allowed, true, "재예약은 허용된다");
  const reservedDay = await db.query<{ offset_days: number | null; has_day: boolean }>(`
    select (quota_kst_day - (clock_timestamp() at time zone 'Asia/Seoul')::date) as offset_days,
           (quota_kst_day is not null) as has_day
    from public.genius_question_jobs where message_id = 777
  `);
  // ⚠️ NULL 검사를 먼저 한다. `Number(null) === 0` 이라 이걸 빼면 "기록 안 함"이
  // offset 0 과 구분되지 않아 계약 무효화 변종이 그대로 GREEN 이 된다(실제로 밟음).
  assert.equal(
    reservedDay.rows[0]?.has_day,
    true,
    "예약 RPC 는 quota_kst_day 를 반드시 기록해야 한다(NULL 금지)",
  );
  assert.equal(
    Number(reservedDay.rows[0]?.offset_days),
    0,
    "예약 RPC 는 차감한 버킷의 KST 날짜를 job 에 기록해야 한다",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
