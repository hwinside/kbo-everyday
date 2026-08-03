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

  // 실제 배포 순서의 후속 CHECK migration을 그대로 적용한다.
  await db.exec(readMigration("20260801_baseball_genius_ack_match_path.sql"));
  await db.exec(readMigration("20260801_baseball_genius_rag_match_path.sql"));
  await db.exec(readMigration("20260803220000_baseball_genius_player_picker.sql"));

  const userId = "00000000-0000-4000-8000-000000000001";
  await db.exec(`
    insert into public.genius_question_logs(match_path)
      values ('rag'), ('error'), ('player_picker'), ('kbo_structured');
    insert into public.genius_question_jobs(
      message_id, user_id, status, source, quota_reserved, quota_allowed, quota_remaining, quota_released
    ) values (1, '${userId}', 'awaiting_selection', 'player_picker', true, true, 4, true);
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
    status: string; picked_player_kbo_id: string; quota_reserved: boolean; source: string | null;
  }>("select status,picked_player_kbo_id,quota_reserved,source from genius_question_jobs where message_id=1");
  assert.deepEqual(selected.rows[0], {
    status: "queued", picked_player_kbo_id: "69102", quota_reserved: false, source: null,
  }, "선택값 persist + 최종답변 quota 재예약 상태");
  await assert.rejects(
    () => db.exec("insert into public.genius_question_logs(match_path) values ('player_rag')"),
    /check constraint|23514/i,
  );
  await db.close();
  console.log("PASS genius match_path DB actual — picker migration/CHECK/RPC + rag/kbo_structured ledger + 미지 경로 거부");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
