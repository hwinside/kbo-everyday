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
    -- 서버가 실제로 쓰는 컬럼을 그대로 세운다. 일부만 세우면 buildQuestionLogRow 가
    -- 새 컬럼을 보내도 이 게이트가 그걸 못 잡는다(= 직전 회차의 단절 그대로).
    CREATE TABLE genius_question_logs (
      user_id uuid,
      question text,
      question_norm text,
      question_normalized text,
      question_normalize_status text,
      question_correction_candidate text,
      match_path text,
      answer text,
      input_tokens integer,
      output_tokens integer,
      question_message_id bigint
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
/**
 * 서버가 제안 카드를 확정하는 종단 경로.
 * quota 반납과 후보 durable 저장을 **한 트랜잭션**으로 묶는다(삼순 2026-08-13 quota/crash).
 */
async function settleSuggestion(db: Db, messageId: number, candidate: string) {
  const r = await db.query<{ settle_baseball_genius_correction_suggestion: boolean }>(
    `SELECT settle_baseball_genius_correction_suggestion($1,$2,$3,$4)`,
    [messageId, UID, "혹시 아래 질문을 뜻하셨나요?", candidate],
  );
  return r.rows[0].settle_baseball_genius_correction_suggestion;
}

async function markSuggested(db: Db, messageId: number, candidate: string) {
  // 서버와 같은 순서: processing → settle RPC(반납+후보 저장 원자) → 발송 후 awaiting_selection.
  // 직접 UPDATE 로 흥내내면 quota 계약을 아예 안 태우므로 생애주기 축이 false-green 이 된다.
  await db.query(`UPDATE genius_question_jobs SET status='processing' WHERE message_id=$1`, [messageId]);
  const ok = await settleSuggestion(db, messageId, candidate);
  if (!ok) throw new Error(`settle failed for ${messageId}`);
  await db.query(
    `UPDATE genius_question_jobs SET status='awaiting_selection' WHERE message_id=$1`, [messageId],
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
  // 제안은 답변이 아니라 quota 를 반납한다. 단, 반납과 후보 저장을 **따로** 하면 그 사이
  // crash 가 무료 질문(used=0) 또는 이중 과금을 만들어서(삼순 2026-08-13 quota/crash),
  // 한 트랜잭션으로 묶은 settle 경로만 태운다.
  await markSuggested(db, 1, "보크가 뭐야?");
  await check("T5b 제안 확정이 quota 를 반납해 사용량이 0 으로 돌아온다", async () => {
    assert.equal(await usedToday(db), 0);
  });
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
  // markSuggested 를 하지 않는다 = 제안 확정 직전 crash
  await check("T9 제안이 저장되지 않은 행은 어떤 응답도 수용하지 않는다", async () => {
    assert.equal(await respond(db, 5, "보크가 뭐야?"), false);
    assert.equal(await respond(db, 5, null), false);
  });

  // ── T11 crash → cron 재개 생애주기 (삼순 2026-08-13 quota/crash 핵심) ───────
  //
  // 사고 시나리오: 제안 확정 직전에 죽으면 quota 는 예약된 채로 남고 제안은 없다.
  // cron 이 이어받아 다시 돌리면 reserve 가 멱등으로 통과해야 하고(재차감 없음),
  // 최종적으로 유저가 물리는 건 **정확히 1회**여야 한다.
  await seedJob(db, 11);
  await reserve(db, 11);
  const usedAfterCrash = await usedToday(db);
  await db.query(`UPDATE genius_question_jobs SET status='processing' WHERE message_id=11`);
  // 💥 여기서 crash — settle 이 실행되지 않았다.
  await check("T11a crash 시점에는 예약만 남고 제안은 없다", async () => {
    const row = (await db.query<Record<string, unknown>>(
      `SELECT * FROM genius_question_jobs WHERE message_id=11`)).rows[0];
    assert.equal(row.correction_options, null);
    assert.equal(row.quota_reserved, true);
    assert.equal(row.quota_released, false);
  });
  await reserve(db, 11); // cron 재개
  await check("T11b cron 재개의 reserve 는 멱등 — 재차감 0", async () => {
    assert.equal(await usedToday(db), usedAfterCrash);
  });
  await markSuggested(db, 11, "보크가 뭐야?");
  await check("T11c 재개 후 제안 확정이 예약을 반납한다", async () => {
    assert.equal(await usedToday(db), usedAfterCrash - 1);
  });
  await respond(db, 11, "보크가 뭐야?");
  await reserve(db, 11);
  await reserve(db, 11); // worker 재진입
  await check("T11d crash→재개 전체에서 최종 차감은 정확히 1회", async () => {
    assert.equal(await usedToday(db), usedAfterCrash);
  });

  // ── T12 제안 확정은 **원자** — 반납만 되고 후보가 사라지는 상태가 없다 ──────
  await seedJob(db, 12);
  await reserve(db, 12);
  await db.query(`UPDATE genius_question_jobs SET status='processing' WHERE message_id=12`);
  await settleSuggestion(db, 12, "보크가 뭐야?");
  await check("T12 반납과 후보 저장이 같은 트랜잭션에서 함께 확정된다", async () => {
    const row = (await db.query<Record<string, unknown>>(
      `SELECT * FROM genius_question_jobs WHERE message_id=12`)).rows[0];
    assert.equal(row.quota_released, true, "반납 표시 없음 — 선택 시 예약을 새로 안 열어 무료 답변이 된다");
    assert.deepEqual(row.correction_options, ["보크가 뭐야?"], "후보 유실 — 유저가 빈 카드를 받는다");
    assert.equal(row.status, "ready");
  });

  // ── T13 settle 재시도는 두 번 반납하지 않는다 ──────────────────────
  await seedJob(db, 13);
  await reserve(db, 13);
  const usedBefore13 = await usedToday(db);
  await db.query(`UPDATE genius_question_jobs SET status='processing' WHERE message_id=13`);
  await settleSuggestion(db, 13, "보크가 뭐야?");
  await db.query(`UPDATE genius_question_jobs SET status='processing' WHERE message_id=13`);
  await settleSuggestion(db, 13, "보크가 뭐야?");
  await check("T13 settle 재시도가 이중 반납을 만들지 않는다", async () => {
    assert.equal(await usedToday(db), usedBefore13 - 1);
  });

  // ── T14 settle 은 **자기가 소유한 processing 행**에만 쓴다 ────────────────
  //
  // 소유권 조건이 없으면 늦게 깨어난 worker 가 **이미 유저가 응답한 행**을 제안 상태로
  // 되돌려 선택을 날리고 카드를 다시 띄운다. 상태를 손대지 않고 false 여야 한다.
  await seedJob(db, 14);
  await reserve(db, 14);
  await markSuggested(db, 14, "보크가 뭐야?");
  await respond(db, 14, "보크가 뭐야?"); // 유저가 골랐다 → status='queued', 선택 고정
  const beforeLate = (await db.query<Record<string, unknown>>(
    `SELECT status, picked_normalized_question, correction_options FROM genius_question_jobs WHERE message_id=14`)).rows[0];
  const usedBeforeLate = await usedToday(db);
  const lateSettle = await settleSuggestion(db, 14, "보크가 뭐야?"); // 좌비 worker
  const afterLate = (await db.query<Record<string, unknown>>(
    `SELECT status, picked_normalized_question, correction_options FROM genius_question_jobs WHERE message_id=14`)).rows[0];
  await check("T14a 소유가 아닌 행에 대한 settle 은 false 로 물러난다", () => {
    assert.equal(lateSettle, false);
  });
  await check("T14b 좌비 settle 이 유저 선택을 되돌리지 않는다", () => {
    assert.equal(afterLate.status, beforeLate.status, "진행 상태가 제안으로 후퇴했다");
    assert.equal(afterLate.picked_normalized_question, "보크가 뭐야?", "선택이 날아갔다");
    assert.equal(afterLate.correction_options, null, "카드가 다시 뜼워졌다");
  });
  await check("T14c 좌비 settle 은 quota 를 다시 건드리지 않는다", async () => {
    assert.equal(await usedToday(db), usedBeforeLate);
  });

  // ── T15 ready 전환 **경로 선택**이 서버 SSOT 에서 실제로 갈리는가 ─────────
  //
  // 🔴 직전 회차 결손: 이 분기가 server.ts 안에 인라인으로만 있어 게이트가 못 태웠고,
  //    비원자 update 로 되돌려도 GREEN 이었다. 이젠 SSOT 를 그대로 실행해 판정한다.
  const { planQuestionJobReady } = await import("../../src/lib/baseball-qa/job-ready-plan");
  type Plan = ReturnType<typeof planQuestionJobReady>;
  const planOf = (r: Record<string, unknown>): Plan =>
    planQuestionJobReady(r as Parameters<typeof planQuestionJobReady>[0], 777);

  await check("T15a 교정 제안은 원자 settle 경로로 간다", () => {
    const plan = planOf({
      answer: "혹시 아래 질문을 뜻하셨나요?", source: "question_correction",
      remaining: 19, correctionOptions: ["보크가 뭐야?"],
    });
    assert.equal(plan.kind, "settle_correction",
      "비원자 update 로 가면 반납·저장이 갈라져 crash 창이 다시 생긴다");
    if (plan.kind !== "settle_correction") return;
    assert.equal(plan.correctionOption, "보크가 뭐야?");
  });

  await check("T15b 일반 답변은 update 경로이고 교정 칸을 반드시 비운다", () => {
    const plan = planOf({ answer: "보크란 …", source: "dictionary", remaining: 19 });
    assert.equal(plan.kind, "update");
    if (plan.kind !== "update") return;
    assert.equal(plan.row.correction_options, null,
      "교정 칸이 남으면 엉뚝한 답변에 카드가 붙는다");
    void 0;
    assert.equal(plan.row.correction_question_message_id, null);
  });

  await check("T15c 후보가 1개가 아니면 settle 경로로 보내지 않는다(fail-close)", () => {
    for (const opts of [undefined, [], ["a", "b"]]) {
      const plan = planOf({
        answer: "x", source: "question_correction", remaining: 19, correctionOptions: opts,
      });
      assert.equal(plan.kind, "update", `correctionOptions=${JSON.stringify(opts)}`);
    }
  });

  // 그리고 그 계획이 실제 DB 에서 의도대로 동작하는지까지 본다(계획만 맞고 행이 틀리면 무의미).
  await seedJob(db, 15);
  await reserve(db, 15);
  const usedBefore15 = await usedToday(db);
  await db.query(`UPDATE genius_question_jobs SET status='processing' WHERE message_id=15`);
  {
    const plan = planOf({
      answer: "혹시 아래 질문을 뜻하셨나요?", source: "question_correction",
      remaining: 19, correctionOptions: ["보크가 뭐야?"],
    });
    if (plan.kind === "settle_correction") {
      await settleSuggestion(db, 15, plan.correctionOption);
    } else {
      const cols = Object.keys(plan.row);
      await db.query(
        `UPDATE genius_question_jobs SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(",")}
         WHERE message_id=$1 AND status='processing'`,
        [15, ...cols.map((c) => plan.row[c] ?? null)],
      );
    }
  }
  await check("T15d SSOT 계획대로 실행하면 반납과 후보가 함께 확정된다", async () => {
    const row = (await db.query<Record<string, unknown>>(
      `SELECT quota_released, correction_options, status FROM genius_question_jobs WHERE message_id=15`)).rows[0];
    assert.equal(await usedToday(db), usedBefore15 - 1, "제안 턴인데 차감이 남았다");
    assert.equal(row.quota_released, true);
    assert.deepEqual(row.correction_options, ["보크가 뭐야?"]);
    assert.equal(row.status, "ready");
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

  // ── Production INSERT 종단 (삼순 2026-08-13 ① 재지적) ────────────────────
  //
  // 🔴 직전 회차까지 이 게이트는 DB 에 **직접** INSERT 해서 "칸과 CHECK 가 있다"만 보았고,
  //    서버가 그 칸을 실제로 채우는지는 보지 않았다. 그래서 pipeline 이 후보를 만들어도
  //    Production INSERT 에 칸이 없어 DB 는 계속 null 인 단절을 몸랏다.
  //    이제 **서버가 쓰는 바로 그 행 조립 함수**를 태우고 그 결과를 실 테이블에 넣어 대조한다.
  const { buildQuestionLogRow } = await import("../../src/lib/baseball-qa/log-row");

  /** 서버 행 조립 결과를 그대로 실 테이블에 넣고 저장된 행을 돌려준다. */
  async function insertViaServer(entry: Record<string, unknown>) {
    const row = buildQuestionLogRow(
      entry as Parameters<typeof buildQuestionLogRow>[0], 4242,
    ) as Record<string, unknown>;
    // 게이트 스키마에 없는 컬럼은 무시하지 않고 **실패하게** 둔다 — 서버가 쓰려는
    // 컬럼이 실제로 없으면 Production 에서도 INSERT 가 터진다.
    const cols = Object.keys(row);
    const vals = cols.map((_, i) => `$${i + 1}`).join(",");
    await db.query(
      `INSERT INTO genius_question_logs (${cols.join(",")}) VALUES (${vals})`,
      cols.map((c) => row[c] ?? null),
    );
    return (await db.query<Record<string, unknown>>(
      `SELECT * FROM genius_question_logs WHERE question_message_id = 4242`)).rows;
  }

  const base = {
    userId: UID, questionNorm: "보끄가모야", answer: null, inputTokens: null, outputTokens: null,
  };

  await check("PROD INSERT: 제안 턴은 서버가 후보를 전용 칸에 실제로 쓴다", async () => {
    const rows = await insertViaServer({
      ...base, question: "보끄가모야", matchPath: "question_correction",
      correctionCandidate: "보크가 뭐야?", normalizeStatus: "suggested",
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].question, "보끄가모야", "원문은 항상 보존된다");
    assert.equal(rows[0].question_correction_candidate, "보크가 뭐야?",
      "pipeline 이 만든 correctionCandidate 가 DB 까지 도착해야 한다");
    assert.equal(rows[0].question_normalized, null, "제안문은 수용문 칸을 오염하지 않는다");
    assert.equal(rows[0].question_normalize_status, "suggested");
  });

  await db.query(`DELETE FROM genius_question_logs WHERE question_message_id = 4242`);
  await check("PROD INSERT: 수용 턴은 수용문 칸만 채우고 제안 칸은 비운다", async () => {
    const rows = await insertViaServer({
      ...base, question: "보끄가모야", matchPath: "dictionary",
      questionNormalized: "보크가 뭐야?", normalizeStatus: "accepted_user",
    });
    assert.equal(rows[0].question_normalized, "보크가 뭐야?");
    assert.equal(rows[0].question_correction_candidate, null);
  });

  await db.query(`DELETE FROM genius_question_logs WHERE question_message_id = 4242`);
  await check("PROD INSERT: 거절 턴은 두 칸 모두 비고 status 만 남긴다", async () => {
    const rows = await insertViaServer({
      ...base, question: "보끄가모야", matchPath: "llm", normalizeStatus: "declined",
    });
    assert.equal(rows[0].question_normalize_status, "declined");
    assert.equal(rows[0].question_normalized, null);
    assert.equal(rows[0].question_correction_candidate, null);
  });

  await db.query(`DELETE FROM genius_question_logs WHERE question_message_id = 4242`);
  await check("PROD INSERT: 서버 행에 제안 칸이 아예 없으면 즉시 RED", () => {
    // 이것이 직전 회차의 결손을 직접 잡는 앞커다 — 서버가 칸을 안 쓰면 여기서 죽는다.
    const row = buildQuestionLogRow({
      ...base, question: "보끄가모야", matchPath: "question_correction",
      correctionCandidate: "보크가 뭐야?", normalizeStatus: "suggested",
    } as Parameters<typeof buildQuestionLogRow>[0], 1) as Record<string, unknown>;
    assert.ok("question_correction_candidate" in row,
      "Production INSERT 행에 question_correction_candidate 칸이 없다");
    assert.equal(row.question_correction_candidate, "보크가 뭐야?");
  });

  console.log(`genius-question-correction-db: PASS ${checks.length}/${checks.length}`);
  for (const c of checks) console.log(`  ✅ ${c}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
