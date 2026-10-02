/** Execute the actual migration/RPC in isolated PostgreSQL WASM. Not PostgREST or iOS QA. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const source = readFileSync("supabase/migrations/20261001_live_activity_device_recovery.sql", "utf8");
const token = "a".repeat(64);
const game = "20261001LGSK0";
async function exercise(migration: string) {
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
    await db.exec(migration);
    const call = async (action: string, challenge: string | null = null, overrideToken = token, channel = "generation-a") => {
      const r = await db.query<{ result: { claimed?: boolean; recorded?: boolean; challenges?: { challenge: string }[] } }>(
        `select live_activity_recovery_step($1,$2,'sandbox',$3,$4,$5,'{"gameId":"${game}"}') result`,
        [action, overrideToken, game, channel, challenge]);
      return r.rows[0].result;
    };
    const reset = async () => {
      await db.exec(`update live_activity_channels set recovery_observed_at=now(),recovery_game_state='{"status":"live"}'`);
      await db.exec("truncate live_activity_device_recovery,live_activity_channel_subscriptions,notification_prefs");
      assert.equal((await call("initial")).recorded, true);
      await db.exec("update live_activity_device_recovery set initial_at=now()-interval '3 minutes'");
      return (await call("challenges")).challenges![0].challenge;
    };
    let challenge = await reset();
    assert.equal((await call("claim", challenge)).claimed, true, "eligible exact-device start");
    assert.notEqual((await call("claim", challenge)).claimed, true, "restart at most once");
    challenge = await reset();
    const concurrent = await Promise.all([call("claim",challenge), call("claim",challenge)]);
    assert.equal(concurrent.filter(r => r.claimed).length, 1, "serialized DB duplicate claim");
    // PGlite serializes the connection; independent PostgREST workers remain a separate gate.
    challenge = await reset();
    await call("ack");
    await call("initial"); // Must not erase an earlier ACK.
    assert.notEqual((await call("claim",challenge)).claimed, true, "ACK history blocks restart");
    challenge = await reset();
    await db.exec("update live_activity_device_recovery set challenge_at=now()-interval '31 seconds'");
    assert.notEqual((await call("claim",challenge)).claimed, true, "stale no-card report");
    challenge = await reset();
    assert.notEqual((await call("claim",null)).claimed, true, "no response cannot authorize restart");
    assert.notEqual((await call("claim",challenge,"b".repeat(64))).claimed, true, "unknown device");
    assert.notEqual((await call("claim",challenge,token,"generation-b")).claimed, true, "wrong generation");
    await db.exec("update live_activity_channels set status='ending'");
    assert.notEqual((await call("claim",challenge)).claimed, true, "ended game");
    await db.exec("update live_activity_channels set status='active'");
    challenge = await reset();
    await db.exec("update live_activity_device_recovery set initial_at=now()-interval '91 minutes'");
    assert.notEqual((await call("claim",challenge)).claimed, true, "expired recovery window");
    challenge = await reset();
    await db.exec("insert into notification_prefs select id,false from auth.users");
    assert.notEqual((await call("claim",challenge)).claimed, true, "opt-out");
    challenge = await reset();
    await db.exec("update live_activity_channels set recovery_observed_at=now()-interval '4 minutes'");
    assert.notEqual((await call("claim",challenge)).claimed, true, "stale game snapshot");
    challenge = await reset();
    await db.exec(`update live_activity_channels set last_send_at=null,last_content_state=null,
      recovery_game_state='{"status":"scheduled"}'`);
    assert.equal((await call("claim",challenge)).claimed, true, "pregame without broadcast can restart");
    for (const role of ["anon","authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(() => call("claim",challenge), /permission denied/);
      await db.exec("reset role");
    }
  } finally { await db.close(); }
}
async function main() {
  await exercise(source);
  const mutants = [
    ["restart", source.replace("or v_row.ack_at is not null or v_row.restart_at is not null", "or v_row.ack_at is not null")
      .replace("and restart_at is null;", ";")],
    ["ACK", source.replace("or v_row.ack_at is not null", "")
      .replace(/or exists\(select 1 from public.live_activity_channel_subscriptions[\s\S]*?channel_id=p_channel\)/, "")],
    ["freshness", source.replace("or v_row.challenge_at <= v_now - interval '30 seconds'", "")],
  ];
  for (const [name, sql] of mutants) {
    assert.notEqual(sql, source, `${name} mutation applied`);
    await assert.rejects(() => exercise(sql), { name: "AssertionError" }, `${name} mutant must be RED`);
  }
  console.log("PASS actual recovery RPC + restart/ACK/freshness mutation RED; PostgREST and iOS not covered");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
