/** Actual non-superuser RPC calls; HTTP embedding is tested by the PostgREST gate. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

async function main() {
  const db = new PGlite();
  const migration = readFileSync("supabase/migrations/20260905043000_posts_popularity.sql", "utf8");
  const rpc = (limit: number) => `public.home_popular_posts(now()-interval '7 day', ${limit}, null, '{}', '{}', '{}')`;
  async function ids(role: "anon" | "authenticated", sub: string, limit = 1000) {
    await db.exec(`set role ${role}; set request.jwt.claims = '{"sub":"${sub}"}';`);
    try {
      const user = await db.query<{ current_user: string; rolsuper: boolean }>(
        "select current_user, rolsuper from pg_roles where rolname=current_user");
      assert.equal(user.rows[0].current_user, role);
      assert.equal(user.rows[0].rolsuper, false);
      return (await db.query<{ id: number }>(`select id from ${rpc(limit)}`)).rows.map((r) => Number(r.id));
    } finally { await db.exec("reset role"); }
  }
  try {
    await db.exec(readFileSync("scripts/qa/fixtures/home-popular-rpc.sql", "utf8"));
    await db.exec(migration);
    const a = "00000000-0000-4000-8000-000000000001";
    const b = "00000000-0000-4000-8000-000000000002";
    assert.deepEqual(await ids("anon", "", 6), [125,124,123,122,121,120]);
    console.log("PASS G1 anon non-superuser: sorted public rows, RLS private rows excluded");
    assert.deepEqual(await ids("authenticated", a, 6), [200,125,124,123,122,121]);
    assert.deepEqual(await ids("authenticated", b, 6), [201,125,124,123,122,121]);
    console.log("PASS G2 authenticated A/B: own sentinel visible, other user's sentinel excluded");
    assert.equal((await ids("anon", "")).length, 100, "125 eligible rows, hard cap 100");
    assert.deepEqual(await ids("anon", "", -1), []);
    console.log("PASS G3 limit cap 100 with 125 eligible rows / negative limit 0");
    await db.exec("drop policy public_posts on public.posts; drop policy own_posts on public.posts");
    assert.deepEqual(await ids("anon", ""), []);
    assert.deepEqual(await ids("authenticated", a), []);
    console.log("PASS G4 no SELECT policy: anon/authenticated both return zero (no RLS bypass)");
    const pop = await db.query<{ popularity: number }>(`select popularity from ${rpc(1)}`);
    assert.equal(pop.rows[0].popularity, 501);
    console.log("PASS G5 migration generated column executable");
  } finally { await db.close(); }

}
main().catch((error) => { console.error(error); process.exitCode=1; });
