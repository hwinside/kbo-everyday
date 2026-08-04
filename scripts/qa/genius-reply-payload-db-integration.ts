/**
 * 야잘알봇 reply payload 멱등성 DB actual.
 * 실 migration을 중립 PostgreSQL 17(PGlite)에 적용해 같은 payload 재시도와
 * 다른 payload 충돌, legacy NULL 재시도 계약을 실제 함수 호출로 검증한다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { verifyOpsMessageByDedupKey } from "../../src/lib/cs/send-ops-message";

const migration = readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260802_ops_message_payload.sql"),
  "utf8",
);

const SYS = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-000000000002";
const USER2 = "00000000-0000-0000-0000-000000000003";

async function send(
  db: PGlite,
  userId: string,
  dedupKey: string,
  payload: object | null,
) {
  return db.query<{ conversation_id: string; deduped: boolean }>(
    `select * from public.admin_send_ops_message(
      $1::uuid, $2::uuid, '같은 답변', '{}'::text[], '같은 답변', 'dm', $3, $4::jsonb
    )`,
    [SYS, userId, dedupKey, payload === null ? null : JSON.stringify(payload)],
  );
}

async function main() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.dm_conversations (
      id uuid primary key default gen_random_uuid(),
      user1_id uuid not null,
      user2_id uuid not null,
      origin text not null default 'dm',
      last_message text,
      last_message_at timestamptz,
      unique (user1_id, user2_id)
    );
    create table public.dm_messages (
      id bigint generated always as identity primary key,
      conversation_id uuid not null references public.dm_conversations(id),
      sender_id uuid not null,
      content text not null,
      image_urls text[] not null default '{}',
      dedup_key text unique,
      payload jsonb
    );
  `);
  await db.exec(migration);

  const firstPayload = {
    type: "baseball_genius_reply",
    reply_kind: "answer",
    match_path: "llm",
  };
  const differentPayload = {
    type: "baseball_genius_reply",
    reply_kind: "unavailable",
    match_path: "blocked",
  };

  const first = await send(db, USER, "genius:1", firstPayload);
  assert.equal(first.rows[0]?.deduped, false);

  const same = await send(db, USER, "genius:1", firstPayload);
  assert.equal(same.rows[0]?.deduped, true, "동일 payload 재시도는 멱등 성공이어야 한다");

  await assert.rejects(
    () => send(db, USER, "genius:1", differentPayload),
    /dedup_key_conflict_foreign|23505/,
    "다른 payload 재시도를 성공 처리하면 화면 표정이 최초 payload에 고착된다",
  );

  const stored = await db.query<{ payload: object; count: number }>(
    `select payload, count(*)::int as count
       from public.dm_messages where dedup_key = 'genius:1' group by payload`,
  );
  assert.equal(stored.rows[0]?.count, 1);
  assert.deepEqual(stored.rows[0]?.payload, firstPayload, "충돌 뒤 최초 payload가 보존돼야 한다");

  const legacyFirst = await send(db, USER2, "legacy:1", null);
  const legacyRetry = await send(db, USER2, "legacy:1", null);
  assert.equal(legacyFirst.rows[0]?.deduped, false);
  assert.equal(legacyRetry.rows[0]?.deduped, true, "기존 NULL payload 재발송 계약이 깨지면 안 된다");

  const legacyCount = await db.query<{ count: number }>(
    `select count(*)::int as count from public.dm_messages where dedup_key = 'legacy:1'`,
  );
  assert.equal(legacyCount.rows[0]?.count, 1);

  const selectedShapes: Array<{ table: string; columns: string }> = [];
  const helperAdmin = {
    from(table: string) {
      let selected = "";
      const chain = {
        select(columns: string) {
          selected = columns;
          selectedShapes.push({ table, columns });
          return chain;
        },
        eq() { return chain; },
        async maybeSingle() {
          if (table === "dm_conversations") {
            return selected === "id"
              ? { data: { id: "conversation-1" }, error: null }
              : { data: null, error: { code: "42703", message: "column dm_conversations.payload does not exist" } };
          }
          if (table === "dm_messages") {
            return selected === "id, payload"
              ? { data: { id: 1, payload: firstPayload }, error: null }
              : { data: { id: 1 }, error: null };
          }
          return { data: null, error: { code: "42P01", message: "unexpected table" } };
        },
      };
      return chain;
    },
  };
  const helperSame = await verifyOpsMessageByDedupKey(
    helperAdmin as never, SYS, USER, "genius:1", "같은 답변", firstPayload,
  );
  const helperMismatch = await verifyOpsMessageByDedupKey(
    helperAdmin as never, SYS, USER, "genius:1", "같은 답변", differentPayload,
  );
  assert.equal(helperSame.ok && helperSame.found, true, "helper 동일 payload 검증 실패");
  assert.deepEqual(helperMismatch, { ok: true, found: false }, "helper가 다른 payload를 성공 처리했다");
  assert.deepEqual(
    selectedShapes,
    [
      { table: "dm_conversations", columns: "id" },
      { table: "dm_messages", columns: "id, payload" },
      { table: "dm_conversations", columns: "id" },
      { table: "dm_messages", columns: "id, payload" },
    ],
    "PostgREST select shape가 production schema와 다르면 false-green이다",
  );

  console.log("PASS reply payload DB actual — RPC+helper payload 일치 / mismatch 23505 / legacy NULL 무회귀");
  await db.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
