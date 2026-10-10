import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const token = "a".repeat(64);
const game = "20261001LGSK0";
test("separate request ledger retains mismatch, preserves recovery state and restricts access", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create schema auth; create schema extensions;
      create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key);
      -- pgcrypto digest(text,sha256) compatibility; use PostgreSQL's actual SHA256.
      create function extensions.digest(text,text) returns bytea language sql immutable as
        'select sha256(convert_to($1,''UTF8''))';
      create table live_activity_start_tokens(user_id uuid, push_to_start_token text unique, os_major int);
      create table live_activity_channels(game_id text, environment text, channel_id text, status text,
        last_send_at timestamptz,last_content_state jsonb, primary key(game_id,environment));
      create table live_activity_channel_subscriptions(game_id text, device_key text,environment text,
        channel_id text,user_id uuid,confirmed_at timestamptz,primary key(game_id,device_key,environment));
      create table notification_prefs(user_id uuid,live_activity boolean);
      insert into auth.users values('00000000-0000-4000-8000-000000000001');
      insert into live_activity_start_tokens values('00000000-0000-4000-8000-000000000001','${token}',18);
      insert into live_activity_channels values('${game}','sandbox','generation-a','active',now(),'{"status":"live"}');
    `);
    await db.exec(readFileSync("supabase/migrations/20261001_live_activity_device_recovery.sql", "utf8"));
    await db.exec(readFileSync("supabase/migrations/20261010_live_activity_wake_observability.sql", "utf8"));
    await db.query("select live_activity_recovery_step('initial',$1,'sandbox',$2,'generation-a')", [token, game]);
    await db.exec("update live_activity_device_recovery set initial_at=now()-interval '3 minutes'");
    const before = await db.query("select * from live_activity_device_recovery");
    const record = (t: string, env: string, n: number | null = 0, failed = false) => db.query(
      "select record_live_activity_challenges_request($1,$2,clock_timestamp(),$3,$4)", [t, env, n, failed]);
    await record(token, "sandbox", 1);
    await record(token, "production");
    await record("b".repeat(64), "sandbox");
    await record(token, "sandbox", null, true);
    const { rows } = await db.query<{ owner_matched: boolean; snapshot_reasons: Record<string,number>; rpc_failed: boolean; issued_count: number | null }>(
      "select * from live_activity_challenges_requests order by recorded_at");
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0].snapshot_reasons, { eligible: 1 });
    assert.deepEqual(rows[1].snapshot_reasons, { environment_mismatch: 1 });
    assert.equal(rows[2].owner_matched, false);
    assert.deepEqual(rows[2].snapshot_reasons, { token_unmatched: 1 });
    assert.equal(rows[3].rpc_failed, true);
    assert.equal(rows[3].issued_count, null);
    assert.ok(!JSON.stringify(rows).includes(token));
    assert.deepEqual((await db.query("select * from live_activity_device_recovery")).rows, before.rows);
    await db.exec("set role authenticated");
    await assert.rejects(db.query("select * from live_activity_challenges_requests"));
    await assert.rejects(record(token,"sandbox"));
  } finally { await db.close(); }
});
