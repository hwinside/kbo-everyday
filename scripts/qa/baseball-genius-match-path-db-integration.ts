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
      source text
    );
  `);

  // 실제 배포 순서의 후속 CHECK migration을 그대로 적용한다.
  await db.exec(readMigration("20260801_baseball_genius_ack_match_path.sql"));
  await db.exec(readMigration("20260801_baseball_genius_rag_match_path.sql"));

  await db.exec(`
    insert into public.genius_question_logs(match_path) values ('rag'), ('error');
    insert into public.genius_question_jobs(message_id, source) values (1, 'rag');
  `);
  const rows = await db.query<{ match_path: string }>(
    "select match_path from public.genius_question_logs order by match_path",
  );
  assert.deepEqual(rows.rows.map((row) => row.match_path), ["error", "rag"]);
  const ledger = await db.query<{ source: string }>(
    "select source from public.genius_question_jobs where message_id = 1",
  );
  assert.equal(ledger.rows[0]?.source, "rag");
  await assert.rejects(
    () => db.exec("insert into public.genius_question_logs(match_path) values ('player_rag')"),
    /check constraint|23514/i,
  );
  await db.close();
  console.log("PASS genius match_path DB actual — logs CHECK rag 허용 / job ledger rag 보존 / 미지 경로 거부");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
