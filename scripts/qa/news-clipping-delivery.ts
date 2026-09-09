/** Reviewer-owned. Real PostgreSQL semantics in PGlite, no network or real recipients. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { runClippingDelivery, CLIPPING_BATCH_SIZE, CLIPPING_RPC_TIMEOUT_MS } from "../../src/lib/news-clipping-delivery";

const migrationPath = "supabase/migrations/20260909110000_news_clipping_atomic_delivery.sql";
const sql = readFileSync(process.env.NEWS_CLIPPING_SQL_PATH ?? migrationPath, "utf8");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const array = (ids: string[]) => `{${ids.join(",")}}`;

async function verifyDatabase() {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
      SELECT set_config('request.jwt.claim.role', 'service_role', false);
      CREATE TABLE profiles(id uuid PRIMARY KEY, team_id integer, nickname text);
      CREATE TABLE notification_prefs(user_id uuid PRIMARY KEY REFERENCES profiles, news_clipping boolean);
      CREATE TABLE news_clipping_sends(clip_date date, user_id uuid REFERENCES profiles, team_id integer,
        created_at timestamptz DEFAULT now(), PRIMARY KEY(clip_date,user_id));
      ALTER TABLE news_clipping_sends ENABLE ROW LEVEL SECURITY;
      CREATE TABLE dm_conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user1_id uuid REFERENCES profiles,
        user2_id uuid REFERENCES profiles, last_message text, last_message_at timestamptz, UNIQUE(user1_id,user2_id));
      CREATE TABLE dm_messages(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        conversation_id uuid REFERENCES dm_conversations, sender_id uuid REFERENCES profiles,
        content text, payload jsonb, created_at timestamptz DEFAULT now());
      CREATE TABLE news_clipping_digests(id bigint PRIMARY KEY, clip_date date, team_id integer, articles jsonb);
      CREATE TABLE notification_probe(message_id bigint);
      CREATE FUNCTION probe_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.content='FAIL_AFTER_FIRST' AND NEW.payload->>'intro' LIKE '%Fault-B%' THEN
          RAISE EXCEPTION 'injected message failure';
        END IF;
        INSERT INTO notification_probe VALUES(NEW.id); RETURN NEW;
      END $$;
      CREATE TRIGGER message_probe AFTER INSERT ON dm_messages FOR EACH ROW EXECUTE FUNCTION probe_message();
    `);
    await db.exec(sql);
    // Catalog assertion verifies the deployed definition, not just SQL text.
    // PostgREST must honor this function setting; live HTTP timing is separate QA.
    const config = (await db.query<{ proconfig: string[]; defaults: string }>(`
      SELECT proconfig, pg_get_expr(proargdefaults, 0) AS defaults
      FROM pg_proc WHERE oid =
        'public.deliver_news_clipping_batch(date,integer,uuid,uuid,uuid[],text,jsonb,text,integer,uuid[])'::regprocedure
    `)).rows[0];
    assert.ok(config.proconfig.includes("statement_timeout=15s"), "RPC server timeout missing or changed");
    assert.ok(15_000 < CLIPPING_RPC_TIMEOUT_MS, "server timeout must precede client abort");
    assert.equal(CLIPPING_BATCH_SIZE, 200);
    assert.match(config.defaults, /^200,/, "SQL default must match client batch size");
    const dates = (await db.query<{ day: string; yesterday: string; previous: string }>(`
      SELECT to_char(now() AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS day,
        to_char((now() AT TIME ZONE 'Asia/Seoul')::date-1,'YYYY-MM-DD') AS yesterday,
        to_char((now() AT TIME ZONE 'Asia/Seoul')::date-2,'YYYY-MM-DD') AS previous
    `)).rows[0];
    const excluded = Array.from({ length: 11 }, (_, i) => uuid(i + 1));
    for (let i = 1; i <= 11; i++) await db.query("INSERT INTO profiles VALUES($1,$2,$3)", [uuid(i), i <= 10 ? i : 1, "system"]);
    for (let team = 1; team <= 10; team++) {
      for (let fan = 0; fan < 3; fan++) {
        const id = uuid(100 + team * 10 + fan);
        await db.query("INSERT INTO profiles VALUES($1,$2,$3)", [id, team, `Fan-${team}-${fan}`]);
        if (fan !== 0) await db.query("INSERT INTO notification_prefs VALUES($1,$2)", [id, fan === 1]);
      }
    }
    const payload = (team: number, date = dates.yesterday) => ({ type: "news_clipping", team_id: team,
      team_name: `Team ${team}`, date, overview: "Fixture", articles: [{ title: "Fixture" }] });
    const send = async (team: number, options: { limit?: number; ids?: string[]; content?: string; day?: string; body?: object } = {}) => {
      const row = await db.query<{ result: { sent: number; remaining: number; firstIntro: number; targets: number; skippedPref: number; alreadySent: number } }>(`
        SELECT public.deliver_news_clipping_batch($1::date,$2::int,$3::uuid,$4::uuid,$5::uuid[],
          $6::text,$7::jsonb,$8::text,$9::int,$10::uuid[]) AS result
      `, [options.day ?? dates.day, team, uuid(team), uuid(11), array(excluded), options.content ?? "Clipping",
        JSON.stringify(options.body ?? payload(team)), "Hello {{nickname}}", options.limit ?? 1,
        options.ids ? array(options.ids) : null]);
      return row.rows[0].result;
    };
    const count = async (table: string) => Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
    for (let team = 1; team <= 10; team++) {
      const first = await send(team);
      assert.equal(first.sent, 1); assert.equal(first.remaining, 1);
      assert.equal(first.targets, 3); assert.equal(first.skippedPref, 1); assert.equal(first.firstIntro, 1);
      const second = await send(team);
      assert.equal(second.sent, 1); assert.equal(second.remaining, 0);
      const replay = await send(team);
      assert.equal(replay.sent, 0); assert.equal(replay.alreadySent, 2);
    }
    assert.equal(await count("news_clipping_sends"), 20);
    assert.equal(await count("dm_messages"), 20);
    assert.equal(await count("notification_probe"), 20);
    const optOuts = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM news_clipping_sends s
      JOIN notification_prefs p ON p.user_id=s.user_id WHERE NOT p.news_clipping`);
    assert.equal(optOuts.rows[0].n, 0);

    // Failure after one message must roll back both claims, conversations,
    // messages and downstream transactional notification rows for the batch.
    const faultIds = [uuid(901), uuid(902)];
    await db.query("INSERT INTO profiles VALUES($1,8,'Fault-A'),($2,8,'Fault-B')", faultIds);
    const before = await Promise.all([count("news_clipping_sends"), count("dm_conversations"), count("dm_messages"), count("notification_probe")]);
    await assert.rejects(send(8, { ids: faultIds, limit: 2, content: "FAIL_AFTER_FIRST" }), /injected message failure/);
    const after = await Promise.all([count("news_clipping_sends"), count("dm_conversations"), count("dm_messages"), count("notification_probe")]);
    assert.deepEqual(after, before, "partial batch survived a failed message");
    assert.equal((await send(8, { ids: faultIds, limit: 2 })).sent, 2);
    assert.equal((await send(8, { ids: faultIds, limit: 2 })).sent, 0, "lost-response retry duplicated delivery");

    // A claim made by the old sender is not a new authorization to replay old
    // DMs. The migration does not backfill, delete, or silently resurrect it.
    await db.query("INSERT INTO profiles VALUES($1,9,'Legacy')", [uuid(903)]);
    await db.query("INSERT INTO news_clipping_sends VALUES($1::date,$2,9,now())", [dates.day, uuid(903)]);
    assert.equal((await send(9, { ids: [uuid(903)] })).sent, 0);
    await assert.rejects(send(9, { day: dates.yesterday, body: payload(9, dates.previous) }), /invalid current-day/);
    await assert.rejects(send(9, { limit: CLIPPING_BATCH_SIZE + 1 }), /invalid current-day/);
    assert.equal((await send(9, { limit: CLIPPING_BATCH_SIZE, ids: [uuid(903)] })).sent, 0);
    await assert.rejects(send(9, { ids: Array(CLIPPING_BATCH_SIZE + 1).fill(uuid(903)) }), /invalid current-day/);
    await assert.rejects(send(9, { body: { ...payload(9), articles: [] } }), /nonempty/);

    // Immutable digest reference and per-recipient intro stay separate.
    await db.query("INSERT INTO profiles VALUES($1,10,'Reference')", [uuid(904)]);
    await db.query("INSERT INTO news_clipping_digests VALUES(1,$1::date,10,'[{\"title\":\"Stored\"}]'::jsonb)", [dates.yesterday]);
    const ref = { type: "news_clipping", team_id: 10, team_name: "Team 10", date: dates.yesterday, digest_id: 1 };
    assert.equal((await send(10, { ids: [uuid(904)], body: ref })).sent, 1);
    const refRow = (await db.query<{ payload: Record<string, unknown> }>("SELECT payload FROM dm_messages WHERE payload->>'digest_id'='1'")).rows[0].payload;
    assert.equal(refRow.digest_id, 1); assert.equal(refRow.articles, undefined);
    assert.equal(refRow.intro, "Hello Reference");
    await assert.rejects(send(9, { body: { ...ref, team_id: 9 } }), /digest scope mismatch/);

    const signature = 'public.deliver_news_clipping_batch(date,integer,uuid,uuid,uuid[],text,jsonb,text,integer,uuid[])';
    for (const role of ["anon", "authenticated"]) {
      const permission = (await db.query<{ allowed: boolean }>("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, signature])).rows[0];
      assert.equal(permission.allowed, false, `${role} can call a private delivery RPC`);
    }
    assert.equal((await db.query<{ allowed: boolean }>("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed, true);
    await db.query("SELECT set_config('request.jwt.claim.role','authenticated',false)");
    await assert.rejects(send(1), /service_role required/);
  } finally { await db.close(); }
}

async function verifyBudget() {
  let calls = 0;
  const make = (sent: number, remaining: number, alreadySent = 0) => ({ sent, remaining, alreadySent,
    targets: 5, skippedPref: 0, firstIntro: sent });
  const completed = await runClippingDelivery(async () => ++calls === 1 ? make(2, 3) : make(3, 0, 2), 100_000, () => 0);
  assert.equal(completed.sent, 5); assert.equal(completed.alreadySent, 0); assert.equal(calls, 2);
  calls = 0;
  const cutoff = await runClippingDelivery(async () => { calls++; return make(1, 4); }, 100_000, () => calls ? 80_000 : 0);
  assert.equal(cutoff.sent, 1); assert.equal(cutoff.remaining, 4); assert.equal(cutoff.timedOut, true); assert.equal(calls, 1);
  calls = 0;
  const notStarted = await runClippingDelivery(async () => { calls++; return make(0, 0); }, 20_000, () => 0);
  assert.equal(calls, 0); assert.equal(notStarted.remaining, null, "unknown progress reported complete");
  await assert.rejects(runClippingDelivery(async () => { throw new Error("unknown transport response"); }, 100_000, () => 0), /unknown transport/);
  await assert.rejects(runClippingDelivery(async () => make(CLIPPING_BATCH_SIZE + 1, 0), 100_000, () => 0), /invalid/);
  const contended = await runClippingDelivery(async () => make(0, 2), 100_000, () => 0);
  assert.equal(contended.batches, 1); assert.equal(contended.remaining, 2);
}

function verifyWiring() {
  const cron = JSON.parse(readFileSync("vercel.json", "utf8")).crons as { path: string; schedule: string }[];
  for (let team = 1; team <= 10; team++) {
    assert.deepEqual(cron.filter((c) => c.path === `/api/cron/news-clipping?teamId=${team}`).map((c) => c.schedule), [`${team - 1},${team + 9},${team + 19},${team + 29} 0 * * *`]);
  }
  assert.ok(!cron.some((c) => c.path === "/api/cron/news-clipping"));
  assert.ok(cron.some((c) => c.path === "/api/cron/news-rag-collect" && c.schedule === "50 23,0 * * *"));
  const route = readFileSync("src/app/api/cron/news-clipping/route.ts", "utf8");
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("// 샘플 발송"));
  assert.match(route, /admin\.rpc\("deliver_news_clipping_batch"/);
  assert.match(route, /p_excluded_user_ids: \[\.\.\.NEWS_CLIPPER_IDS\]/);
  assert.match(route, /p_limit: CLIPPING_BATCH_SIZE/);
  assert.match(route, /abortSignal\(AbortSignal\.timeout\(CLIPPING_RPC_TIMEOUT_MS\)\)/);
  assert.match(get, /result\.remaining === 0/);
  assert.doesNotMatch(get, /claimUsers|dm_messages|ingestNewsArticles/);
  assert.match(sql, /ON CONFLICT \(clip_date, user_id\) DO NOTHING/);
}

async function main() {
  verifyWiring(); await verifyBudget(); await verifyDatabase();
  console.log("News clipping atomic SQL, retry budget, ten-team schedules, and privacy gates PASS");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
