import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

async function main() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE genius_question_logs (
      match_path text, question_normalize_status text
    );
    ALTER TABLE genius_question_logs ADD CONSTRAINT genius_question_logs_match_path_check CHECK (true);
    ALTER TABLE genius_question_logs ADD CONSTRAINT genius_question_logs_normalize_status_check CHECK (true);
    CREATE TABLE genius_question_jobs (
      message_id bigint PRIMARY KEY,
      user_id uuid NOT NULL,
      status text NOT NULL,
      lease_until timestamptz NOT NULL DEFAULT now(),
      answer text,
      source text,
      remaining integer,
      quota_reserved boolean NOT NULL DEFAULT true,
      quota_allowed boolean,
      quota_remaining integer,
      quota_kst_day date,
      quota_released boolean NOT NULL DEFAULT true,
      attempts integer NOT NULL DEFAULT 4,
      delivery_attempts integer NOT NULL DEFAULT 3,
      last_error text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const sql = readFileSync("supabase/migrations/20260813203000_baseball_genius_question_correction_picker.sql", "utf8")
    .replaceAll("public.", "");
  await db.exec(sql);

  const uid = "11111111-1111-4111-8111-111111111111";
  await db.query(`INSERT INTO genius_question_jobs
    (message_id,user_id,status,correction_options,quota_allowed,quota_remaining,quota_kst_day)
    VALUES (7,$1,'awaiting_selection','["보크가 뭐야?"]'::jsonb,true,9,'2026-08-13')`, [uid]);

  const wrong = await db.query<{prepare_baseball_genius_question_correction:boolean}>(
    `SELECT prepare_baseball_genius_question_correction(7,$1,'도루가 뭐야')`, [uid]);
  assert.equal(wrong.rows[0].prepare_baseball_genius_question_correction, false, "후보 밖 위조 선택 거절");

  const accepted = await db.query<{prepare_baseball_genius_question_correction:boolean}>(
    `SELECT prepare_baseball_genius_question_correction(7,$1,'보크가 뭐야?')`, [uid]);
  assert.equal(accepted.rows[0].prepare_baseball_genius_question_correction, true, "서버 발급 exact 후보 수용");
  const row = (await db.query<Record<string, unknown>>(`SELECT * FROM genius_question_jobs WHERE message_id=7`)).rows[0];
  assert.equal(row.status, "queued");
  assert.equal(row.picked_normalized_question, "보크가 뭐야?");
  assert.equal(row.correction_options, null);
  assert.equal(row.quota_reserved, false, "반납된 제안 quota는 최종 답변 예약을 다시 연다");
  assert.equal(row.quota_released, false);
  assert.equal(row.attempts, 0);
  assert.equal(row.delivery_attempts, 0);

  const replay = await db.query<{prepare_baseball_genius_question_correction:boolean}>(
    `SELECT prepare_baseball_genius_question_correction(7,$1,'보크가 뭐야?')`, [uid]);
  assert.equal(replay.rows[0].prepare_baseball_genius_question_correction, true, "동일 선택 재시도 멱등");

  await assert.rejects(
    db.query(`SELECT prepare_baseball_genius_question_correction(7,$1,$2)`, [uid, "x".repeat(201)]),
    /invalid question correction/,
  );
  console.log("genius-question-correction-db: PASS");
}
main().catch((e) => { console.error(e); process.exit(1); });
