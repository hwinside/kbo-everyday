/** Called by the existing PGlite gate. SQL runs as non-superuser roles, never against production. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";

export async function runHomeCommunitySplitCases(db: PGlite) {
  await db.exec(readFileSync("supabase/migrations/20260908063000_home_team_latest_posts.sql", "utf8"));
  await db.exec("begin");
  const a = "00000000-0000-4000-8000-000000000001";
  const b = "00000000-0000-4000-8000-000000000002";
  const now = "2026-09-08T06:00:00Z";
  const latest = (before = "null, null", blocked = "{}", team = "'lg'") =>
    `public.home_team_latest_posts(${team}, 16, '{63123}', '${blocked}', ${before})`;
  async function query(role: "anon" | "authenticated", sub: string, rpc: string) {
    await db.exec(`set role ${role}; set request.jwt.claims = '{"sub":"${sub}"}'`);
    try {
      const user = await db.query<{ rolsuper: boolean }>("select rolsuper from pg_roles where rolname=current_user");
      assert.equal(user.rows[0].rolsuper, false);
      return (await db.query<{ id: number; created_at: string }>(`select id, created_at::text from ${rpc}`)).rows;
    } finally { await db.exec("reset role"); }
  }
  const ids = (rows: { id: number }[]) => rows.map((r) => Number(r.id));
  try {
    await db.exec(`delete from public.posts;
      insert into public.posts(id, author_id, created_at, like_count)
      select i, '${a}', '${now}'::timestamptz - i * interval '1 minute', i from generate_series(1,40) i;
      update public.posts set created_at='${now}'::timestamptz - interval '14 minute' where id=15;
      insert into public.posts(id,author_id,created_at,like_count,team_tags,player_tags,is_hidden,qa_private) values
        (901,'${a}','${now}',100,'["doosan"]','[]',false,false),
        (902,'${a}','${now}',101,'["lg","doosan"]','[]',false,false),
        (903,'${a}','${now}',102,'["lg"]','["63123:타팀선수"]',false,false),
        (904,'${a}','${now}',103,'["lg"]','[]',true,false),
        (905,'${a}','${now}'::timestamptz-interval '8 day',999,'["lg"]','[]',false,false),
        (906,'${b}','${now}',104,'["lg"]','[]',false,false),
        (907,'${a}','${now}',105,'["lg"]','[]',false,true),
        (908,'${b}','${now}',106,'["lg"]','[]',false,true),
        (909,'${a}','${now}'::timestamptz-interval '24 hour',107,'["lg"]','[]',false,false),
        (910,'${a}','${now}'::timestamptz-interval '24 hour 1 second',108,'["lg"]','[]',false,false),
        (911,'${a}','${now}',109,'[]','[]',false,false);`);
    const blocked = `{${b}}`;
    const first = await query("anon", "", latest("null, null", blocked));
    const expected = [...Array.from({ length: 13 }, (_, i) => i + 1), 15, 14];
    assert.deepEqual(ids(first.slice(0, 15)), expected, "latest order ignores popularity; ties use id desc");
    const last = first[14];
    await db.exec(`insert into public.posts(id,author_id,created_at,like_count) values(999,'${a}','${now}',0)`);
    const second = await query("anon", "", latest(`'${last.created_at}', ${last.id}`, blocked));
    assert.deepEqual(ids(second.slice(0, 15)), Array.from({ length: 15 }, (_, i) => i + 16), "new insert does not reorder older pages");
    const last2 = second[14];
    const third = await query("anon", "", latest(`'${last2.created_at}', ${last2.id}`, blocked));
    assert.deepEqual(ids(third), [...Array.from({ length: 10 }, (_, i) => i + 31), 909, 910, 905]);
    assert.ok(third.length < 16, "peek detects exhaustion; 8-day-old latest post remains eligible");
    assert.equal(Number((await query("anon", "", latest("null, null", blocked)))[0].id), 999, "reload sees new zero-reaction post");
    assert.deepEqual(await query("anon", "", latest("null, null", blocked, "null")), [], "no favorite team never falls back to all-team latest");
    assert.deepEqual(await query("anon", "", latest("null, 10", blocked)), [], "incomplete cursor fails closed");
    console.log("PASS S1 latest strict scope, chronological ties, 15→30→43, inserts, no 7-day cutoff, no-team guard");

    const popular = `public.home_popular_posts('${now}'::timestamptz-interval '24 hour',100,null,'{}','{}','{}')`;
    const global = ids(await query("anon", "", popular));
    assert.deepEqual(global.slice(0, 6), [911,909,906,903,902,901], "global popular accepts no-team, multi-team and other-team/player scopes");
    for (const excluded of [904,905,907,908,910]) assert.ok(!global.includes(excluded), `popular excludes hidden/private/outside-24h ${excluded}`);
    assert.ok(global.includes(909), "24h exact boundary is inclusive");
    const authA = ids(await query("authenticated", a, latest()));
    const authB = ids(await query("authenticated", b, latest()));
    assert.ok(authA.includes(907) && !authA.includes(908));
    assert.ok(authB.includes(908) && !authB.includes(907));
    console.log("PASS S2 24h boundary, global popularity, hidden/blocked filters, independent A/B RLS");
  } finally { await db.exec("rollback"); }
}
