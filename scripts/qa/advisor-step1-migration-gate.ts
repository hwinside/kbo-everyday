/**
 * advisor-step1-migration-gate — PR #1175 migration 지속 회귀 (삼순 2차 NO-GO 반영)
 *
 * migration 파일(20260813_advisor_step1_searchpath_dupindex.sql)을 PGlite(실제
 * Postgres)에서 **파일 그대로** replay 한다. 검증 시나리오:
 *  S1 clean-chain: 대상 함수·stray 인덱스가 없는 DB → 에러 없이 no-op (42883 회귀)
 *  S2 prod-like: 함수 9개 + keeper/target 인덱스 존재 → 9함수 search_path 고정
 *     + stray 3개 DROP + keeper 3개 잔존
 *  S3 mutation RED: keeper indisvalid=false (unusable) → EXCEPTION으로 중단,
 *     valid target 잔존 (usable 인덱스 0개 사고 차단 — 삼순 2차 P0)
 *  S4 mutation RED: target 정의 drift → EXCEPTION, target 잔존
 *  S5 mutation RED: keeper 부재(target만 존재) → EXCEPTION, target 잔존
 *
 * 게이트가 migration 파일 자체를 읽으므로(SSOT), 가드를 지우거나 약화시키면
 * S3~S5가 RED로 떨어진다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = join(
  __dirname,
  "..",
  "..",
  "supabase",
  "migrations",
  "20260813_advisor_step1_searchpath_dupindex.sql",
);

let failed = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`[PASS] ${name}`);
  } else {
    failed += 1;
    console.error(`[FAIL] ${name}`, detail ?? "");
  }
}

const migrationSql = readFileSync(MIGRATION, "utf8");

const FUNC_SIGS = [
  "public.notify_push_dispatch()",
  "public.upsert_game_event_state(text, jsonb, jsonb)",
  "public.guard_profiles_is_operator()",
  "public.leaderboard_internal_user_ids()",
  "public.urgent_notice_sender_id()",
  "public.guard_dm_message_dedup_key()",
  "public._assert_quota_date(text)",
  "public._yt_quota_hard_max()",
  "public.venue_story_comment_post(bigint, uuid, text, text)",
];

const TABLES_SQL = `
  CREATE TABLE public.dm_conversations (
    id bigint, user1_id uuid, user2_id uuid, last_message_at timestamptz
  );
  CREATE TABLE public.posts (player_tags text[]);
`;

const KEEPERS_SQL = `
  CREATE INDEX idx_dm_conversations_user1_last_message
    ON public.dm_conversations USING btree (user1_id, last_message_at DESC, id DESC);
  CREATE INDEX idx_dm_conversations_user2_last_message
    ON public.dm_conversations USING btree (user2_id, last_message_at DESC, id DESC);
  CREATE INDEX idx_posts_player_tags ON public.posts USING gin (player_tags);
`;

const STRAYS_SQL = `
  CREATE INDEX idx_dm_conv_user1_last_message
    ON public.dm_conversations USING btree (user1_id, last_message_at DESC, id DESC);
  CREATE INDEX idx_dm_conv_user2_last_message
    ON public.dm_conversations USING btree (user2_id, last_message_at DESC, id DESC);
  CREATE INDEX idx_posts_player_tags_gin ON public.posts USING gin (player_tags);
`;

// production 시그니처와 동일한 더미 함수 (본문은 무관 — ALTER 대상 존재만 필요)
const FUNCS_SQL = `
  CREATE FUNCTION public.notify_push_dispatch() RETURNS trigger LANGUAGE plpgsql AS 'begin return null; end';
  CREATE FUNCTION public.upsert_game_event_state(text, jsonb, jsonb) RETURNS void LANGUAGE sql AS 'select';
  CREATE FUNCTION public.guard_profiles_is_operator() RETURNS trigger LANGUAGE plpgsql AS 'begin return null; end';
  CREATE FUNCTION public.leaderboard_internal_user_ids() RETURNS uuid[] LANGUAGE sql AS 'select array[]::uuid[]';
  CREATE FUNCTION public.urgent_notice_sender_id() RETURNS uuid LANGUAGE sql AS 'select null::uuid';
  CREATE FUNCTION public.guard_dm_message_dedup_key() RETURNS trigger LANGUAGE plpgsql AS 'begin return null; end';
  CREATE FUNCTION public._assert_quota_date(text) RETURNS void LANGUAGE sql AS 'select';
  CREATE FUNCTION public._yt_quota_hard_max() RETURNS integer LANGUAGE sql AS 'select 1';
  CREATE FUNCTION public.venue_story_comment_post(bigint, uuid, text, text) RETURNS void LANGUAGE sql AS 'select';
`;

async function freshDb(setup: string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(setup);
  return db;
}

async function replay(db: PGlite): Promise<{ ok: boolean; error: string }> {
  try {
    await db.exec(migrationSql);
    return { ok: true, error: "" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function indexExists(db: PGlite, name: string): Promise<boolean> {
  const r = await db.query<{ n: number }>(
    "select count(*)::int as n from pg_indexes where schemaname='public' and indexname=$1",
    [name],
  );
  return r.rows[0].n === 1;
}

async function main() {
  // --- S1 clean-chain replay: 함수·stray 없음 → 성공 + keeper 잔존
  {
    const db = await freshDb(TABLES_SQL + KEEPERS_SQL);
    const r = await replay(db);
    assert("S1 clean-chain replay succeeds (42883 회귀)", r.ok, r.error);
    assert(
      "S1 keeper indexes untouched",
      (await indexExists(db, "idx_dm_conversations_user1_last_message")) &&
        (await indexExists(db, "idx_posts_player_tags")),
    );
    await db.close();
  }

  // --- S2 prod-like: 9함수 ALTER + stray DROP + keeper 잔존
  {
    const db = await freshDb(TABLES_SQL + KEEPERS_SQL + STRAYS_SQL + FUNCS_SQL);
    const r = await replay(db);
    assert("S2 prod-like replay succeeds", r.ok, r.error);
    for (const sig of FUNC_SIGS) {
      const q = await db.query<{ cfg: string[] | null }>(
        `select proconfig as cfg from pg_proc where oid = to_regprocedure($1)`,
        [sig],
      );
      assert(
        `S2 search_path pinned: ${sig}`,
        (q.rows[0]?.cfg ?? []).some((c) => c.startsWith("search_path=")),
        q.rows[0]?.cfg,
      );
    }
    for (const stray of [
      "idx_dm_conv_user1_last_message",
      "idx_dm_conv_user2_last_message",
      "idx_posts_player_tags_gin",
    ]) {
      assert(`S2 stray dropped: ${stray}`, !(await indexExists(db, stray)));
    }
    for (const keeper of [
      "idx_dm_conversations_user1_last_message",
      "idx_dm_conversations_user2_last_message",
      "idx_posts_player_tags",
    ]) {
      assert(`S2 keeper kept: ${keeper}`, await indexExists(db, keeper));
    }
    await db.close();
  }

  // --- S3 mutation RED: unusable keeper (indisvalid=false) → 거부 + target 잔존
  {
    const db = await freshDb(TABLES_SQL + KEEPERS_SQL + STRAYS_SQL + FUNCS_SQL);
    await db.exec(`
      UPDATE pg_index SET indisvalid = false
      WHERE indexrelid = 'public.idx_dm_conversations_user1_last_message'::regclass;
    `);
    const r = await replay(db);
    assert("S3 unusable keeper → EXCEPTION (RED)", !r.ok, "migration must refuse");
    assert(
      "S3 error names the guard",
      /not usable|invalid/i.test(r.error),
      r.error.slice(0, 200),
    );
    assert(
      "S3 valid target preserved",
      await indexExists(db, "idx_dm_conv_user1_last_message"),
    );
    await db.close();
  }

  // --- S4 mutation RED: 정의 drift → 거부 + target 잔존
  {
    const db = await freshDb(TABLES_SQL + KEEPERS_SQL + FUNCS_SQL);
    // target을 keeper와 다른 정의로 생성 (컬럼 구성이 다름)
    await db.exec(`
      CREATE INDEX idx_dm_conv_user1_last_message
        ON public.dm_conversations USING btree (user1_id);
    `);
    const r = await replay(db);
    assert("S4 definition drift → EXCEPTION (RED)", !r.ok, "migration must refuse");
    assert("S4 error names drift", /drift/i.test(r.error), r.error.slice(0, 200));
    assert(
      "S4 drifted target preserved",
      await indexExists(db, "idx_dm_conv_user1_last_message"),
    );
    await db.close();
  }

  // --- S5 mutation RED: keeper 부재 → 거부 + target 잔존
  {
    const db = await freshDb(TABLES_SQL + FUNCS_SQL);
    await db.exec(`
      CREATE INDEX idx_dm_conv_user1_last_message
        ON public.dm_conversations USING btree (user1_id, last_message_at DESC, id DESC);
    `);
    const r = await replay(db);
    assert("S5 missing keeper → EXCEPTION (RED)", !r.ok, "migration must refuse");
    assert("S5 error names missing keeper", /missing/i.test(r.error), r.error.slice(0, 200));
    assert(
      "S5 sole index preserved",
      await indexExists(db, "idx_dm_conv_user1_last_message"),
    );
    await db.close();
  }

  console.log(
    failed === 0
      ? "\nAll advisor-step1 migration gate tests PASSED"
      : `\n${failed} test(s) FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
