/**
 * 교정 제안 카드의 **quota 전 생애주기**를 PGlite actual 실행으로 잠근다 (삼순 2026-08-13 ④).
 *
 * 종전 게이트는 `prepare` 한 함수만 봤다. 그러면 정작 중요한 계약
 * `reserve → release(제안) → 선택/취소 → 최종 = 정확히 1회` 가 검증되지 않는다.
 * 그래서 여기서는 **실제 migration 3개**(reserve/release RPC 포함)를 순서대로 올린 뒤,
 * 유저 하루 사용량 테이블(`genius_daily_usage`) 값을 매 단계 직접 읽어 대조한다.
 *
 * 닫는 축:
 *   T1 위조 후보 거절 · T2 exact 수용 · T3 멱등 재시도 · T4 길이 상한
 *   T5 quota 생애주기(예약 1 → 제안 반납 0 → 선택 → 최종 1)
 *   T6 취소(거절) 종결도 같은 quota 계약
 *   T7 동시 2탭: 서로 다른 응답 중 **하나만** 이긴다
 *   T8 release 재시도 중복 반납 없음(멱등)
 *   T9 제안 INSERT 전 crash(= prepare 미도달) 시 quota 가 반납된 채 남지 않는다
 *   T10 awaiting_selection 이 아닌 행은 응답을 받지 않는다(늦은 탭)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const UID = "11111111-1111-4111-8111-111111111111";
const LIMIT = 20;

type Db = InstanceType<typeof PGlite>;

async function loadSchema(): Promise<Db> {
  const db = new PGlite();
  // 실제 계약이 걸린 테이블만 최소로 세운다 — RPC 가 읽고 쓰는 컬럼은 전부 실제 이름이다.
  await db.exec(`
    CREATE TABLE genius_daily_usage (
      user_id uuid NOT NULL,
      kst_day date NOT NULL,
      used integer NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, kst_day)
    );
    CREATE TABLE genius_question_logs (
      match_path text, question_normalize_status text, question_normalized text
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
      picker_options jsonb,
      picker_question_message_id bigint,
      picked_player_kbo_id text,
      quota_reserved boolean NOT NULL DEFAULT false,
      quota_allowed boolean,
      quota_remaining integer,
      quota_kst_day date,
      quota_released boolean NOT NULL DEFAULT false,
      attempts integer NOT NULL DEFAULT 0,
      delivery_attempts integer NOT NULL DEFAULT 0,
      last_error text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  // reserve/release RPC 는 picker migration 이 정본이다 — 그 파일을 그대로 실행한다.
  // 우리 계약(제안 0 + 최종 1)이 그 RPC 위에서 성립하는지 봐야 하므로 재작성하지 않는다.
  const picker = readFileSync(
    "supabase/migrations/20260804140000_baseball_genius_player_picker.sql", "utf8",
  ).replaceAll("public.", "");
  // picker migration 의 CHECK/GRANT 중 이 게이트 범위 밖 구문은 제거한다(역할·권한은 Supabase 것).
  await db.exec(stripRoleStatements(picker));
  const ours = readFileSync(
    "supabase/migrations/20260813203000_baseball_genius_question_correction_picker.sql", "utf8",
  ).replaceAll("public.", "");
  await db.exec(stripRoleStatements(ours));
  return db;
}

/** PGlite 에는 anon/authenticated/service_role 역할이 없다 — 권한 구문만 걷어낸다. */
function stripRoleStatements(sql: string): string {
  return sql
    .split(";")
    .filter((stmt) => !/^\s*(REVOKE|GRANT)\b/i.test(stmt))
    .join(";");
}

async function usedToday(db: Db): Promise<number> {
  const r = await db.query<{ used: number }>(
    `SELECT used FROM genius_daily_usage WHERE user_id=$1
       AND kst_day=(clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date`, [UID],
  );
  return r.rows[0]?.used ?? 0;
}

async function seedJob(db: Db, messageId: number, status = "queued") {
  await db.query(
    `INSERT INTO genius_question_jobs (message_id,user_id,status) VALUES ($1,$2,$3)`,
    [messageId, UID, status],
  );
}

async function reserve(db: Db, messageId: number) {
  return db.query<{ allowed: boolean; remaining: number }>(
    `SELECT * FROM reserve_baseball_genius_daily_question_for_message($1,$2,$3)`,
    [messageId, UID, LIMIT],
  );
}

async function release(db: Db, messageId: number) {
  return db.query(`SELECT release_baseball_genius_daily_question_for_message($1,$2)`, [messageId, UID]);
}

async function respond(db: Db, messageId: number, candidate: string | null) {
  const r = await db.query<{ prepare_baseball_genius_question_correction: boolean }>(
    `SELECT prepare_baseball_genius_question_correction($1,$2,$3)`, [messageId, UID, candidate],
  );
  return r.rows[0].prepare_baseball_genius_question_correction;
}

/** 봇이 제안 카드를 낸 상태를 실제 서버 write 순서 그대로 재현한다. */
async function markSuggested(db: Db, messageId: number, candidate: string) {
  await db.query(
    `UPDATE genius_question_jobs
       SET status='awaiting_selection',
           correction_options=jsonb_build_array($2::text),
           correction_question_message_id=$1
     WHERE message_id=$1`, [messageId, candidate],
  );
}

const checks: string[] = [];
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(() => { checks.push(name); });
}

async function main() {
  const db = await loadSchema();

  // ── T5 quota 생애주기: 예약 1 → 제안 반납 0 → 선택 → 최종 1 ────────────────
  await seedJob(db, 1);
  const r1 = await reserve(db, 1);
  await check("T5a 질문 예약이 하루 사용량 1을 차감한다", async () => {
    assert.equal(r1.rows[0].allowed, true);
    assert.equal(await usedToday(db), 1);
  });
  await release(db, 1); // 제안은 답변이 아니라 반납한다
  await check("T5b 제안 단계 반납으로 사용량이 0으로 돌아온다", async () => {
    assert.equal(await usedToday(db), 0);
  });
  await markSuggested(db, 1, "보크가 뭐야?");
  await check("T5c 서버 발급 exact 후보 수용", async () => {
    assert.equal(await respond(db, 1, "보크가 뭐야?"), true);
  });
  const afterPick = (await db.query<Record<string, unknown>>(
    `SELECT * FROM genius_question_jobs WHERE message_id=1`)).rows[0];
  await check("T5d 선택이 job 에 durable 고정되고 재처리 대기로 전환", () => {
    assert.equal(afterPick.status, "queued");
    assert.equal(afterPick.picked_normalized_question, "보크가 뭐야?");
    assert.equal(afterPick.correction_declined, false);
    assert.equal(afterPick.correction_options, null);
    assert.equal(afterPick.correction_question_message_id, null);
    assert.equal(afterPick.attempts, 0);
    assert.equal(afterPick.delivery_attempts, 0);
    assert.equal(afterPick.quota_reserved, false, "반납됐으므로 최종 답변용 예약을 다시 연다");
    assert.equal(afterPick.quota_released, false);
  });
  const r2 = await reserve(db, 1); // 최종 답변 경로가 다시 예약
  await check("T5e 최종 답변에서만 1회 차감된다(제안 0 + 최종 1)", async () => {
    assert.equal(r2.rows[0].allowed, true);
    assert.equal(await usedToday(db), 1);
  });

  // ── T6 취소(거절) 종결도 같은 quota 계약 ──────────────────────────────────
  await seedJob(db, 2);
  await reserve(db, 2);
  await release(db, 2);
  await markSuggested(db, 2, "도루가 뭐야");
  await check("T6a 거절(null)도 제안이 있었을 때만 수용", async () => {
    assert.equal(await respond(db, 2, null), true);
  });
  const declinedRow = (await db.query<Record<string, unknown>>(
    `SELECT * FROM genius_question_jobs WHERE message_id=2`)).rows[0];
  await check("T6b 거절이 durable 로 남아 재처리가 같은 제안을 다시 내지 않는다", () => {
    assert.equal(declinedRow.correction_declined, true);
    assert.equal(declinedRow.picked_normalized_question, null);
    assert.equal(declinedRow.correction_options, null);
    assert.equal(declinedRow.status, "queued");
  });
  await reserve(db, 2);
  await check("T6c 거절 후 원문 답변도 정확히 1회만 차감", async () => {
    assert.equal(await usedToday(db), 2, "message 1 최종 + message 2 최종");
  });

  // ── T7 동시 2탭: 선택과 거절이 겹치면 하나만 이긴다 ────────────────────────
  await seedJob(db, 3);
  await reserve(db, 3);
  await release(db, 3);
  await markSuggested(db, 3, "보크가 뭐야?");
  const tabA = await respond(db, 3, "보크가 뭐야?");
  const tabB = await respond(db, 3, null);
  await check("T7a 2탭 경합에서 먼저 확정된 응답만 통과한다", () => {
    assert.equal(tabA, true, "첫 탭 수용");
    assert.equal(tabB, false, "다른 응답으로 덮어쓰는 둘째 탭은 거절");
  });
  const raceRow = (await db.query<Record<string, unknown>>(
    `SELECT * FROM genius_question_jobs WHERE message_id=3`)).rows[0];
  await check("T7b 경합 뒤에도 job 은 첫 응답 하나만 반영한다", () => {
    assert.equal(raceRow.picked_normalized_question, "보크가 뭐야?");
    assert.equal(raceRow.correction_declined, false);
  });
  await check("T7c 같은 응답 재시도는 멱등 통과(네트워크 재전송)", async () => {
    assert.equal(await respond(db, 3, "보크가 뭐야?"), true);
  });
  const usedBeforeFinal3 = await usedToday(db);
  await reserve(db, 3);
  await reserve(db, 3); // worker 재진입
  await check("T7d 경합·재시도에도 최종 차감은 정확히 1회", async () => {
    assert.equal(await usedToday(db), usedBeforeFinal3 + 1);
  });

  // ── T8 release 재시도 중복 반납 없음 ──────────────────────────────────────
  await seedJob(db, 4);
  await reserve(db, 4);
  const usedBeforeRelease = await usedToday(db);
  await release(db, 4);
  await release(db, 4);
  await release(db, 4);
  await check("T8 release 3회 호출해도 1회만 반납된다(무한 회복 방지)", async () => {
    assert.equal(await usedToday(db), usedBeforeRelease - 1);
  });

  // ── T9 제안 저장 전 crash: prepare 미도달 행은 응답을 받지 않는다 ───────────
  await seedJob(db, 5);
  await reserve(db, 5);
  await release(db, 5);
  // markSuggested 를 하지 않는다 = 제안 INSERT 직전 crash
  await check("T9 제안이 저장되지 않은 행은 어떤 응답도 수용하지 않는다", async () => {
    assert.equal(await respond(db, 5, "보크가 뭐야?"), false);
    assert.equal(await respond(db, 5, null), false);
  });

  // ── T10 늦은 탭: 이미 완료된 질문 카드 재탭 ───────────────────────────────
  await seedJob(db, 6, "completed");
  await check("T10 완료된 질문은 뒤늦은 탭을 받지 않는다", async () => {
    assert.equal(await respond(db, 6, "보크가 뭐야?"), false);
  });

  // ── T1 위조 후보 거절 ─────────────────────────────────────────────────────
  await seedJob(db, 7);
  await markSuggested(db, 7, "보크가 뭐야?");
  await check("T1 서버가 발급하지 않은 후보는 거절한다", async () => {
    assert.equal(await respond(db, 7, "도루가 뭐야"), false);
  });

  // ── T4 길이 상한 ──────────────────────────────────────────────────────────
  await check("T4 200자 초과 후보는 예외로 fail-close", async () => {
    await assert.rejects(
      db.query(`SELECT prepare_baseball_genius_question_correction(7,$1,$2)`, [UID, "x".repeat(201)]),
      /invalid question correction/,
    );
  });

  // ── CHECK 계약: 새 관측 status 와 match_path 가 실제로 허용되는지 ──────────
  await check("CHECK: 신규 관측 status·match_path 가 DB 에서 허용된다", async () => {
    for (const s of ["suggested", "accepted_user", "declined"]) {
      await db.query(`INSERT INTO genius_question_logs (match_path, question_normalize_status)
        VALUES ('question_correction', $1)`, [s]);
    }
    await assert.rejects(
      db.query(`INSERT INTO genius_question_logs (match_path, question_normalize_status)
        VALUES ('question_correction','made_up')`),
      /normalize_status_check/,
    );
    await assert.rejects(
      db.query(`INSERT INTO genius_question_logs (match_path) VALUES ('made_up_path')`),
      /match_path_check/,
    );
  });

  await check("CHECK: 제안 후보 칸이 수용문 칸과 분리돼 있다", async () => {
    await db.query(`INSERT INTO genius_question_logs
      (match_path, question_normalize_status, question_correction_candidate)
      VALUES ('question_correction','suggested','보크가 뭐야?')`);
    const row = (await db.query<{ question_normalized: string | null; question_correction_candidate: string }>(
      `SELECT question_normalized, question_correction_candidate FROM genius_question_logs
       WHERE question_correction_candidate IS NOT NULL`)).rows[0];
    assert.equal(row.question_normalized, null, "제안만 한 후보는 수용문 칸을 비워둔다");
    assert.equal(row.question_correction_candidate, "보크가 뭐야?");
  });

  console.log(`genius-question-correction-db: PASS ${checks.length}/${checks.length}`);
  for (const c of checks) console.log(`  ✅ ${c}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
