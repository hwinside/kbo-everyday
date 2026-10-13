/** Execute the unchanged migration with real Postgres RLS and a fixture-only clock. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.sub')::uuid $$;
      CREATE TABLE public.season_predictions(user_id uuid NOT NULL, season integer NOT NULL, category text NOT NULL, pick text NOT NULL, UNIQUE(user_id,season,category));
      ALTER TABLE public.season_predictions ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA public, auth TO authenticated;
      GRANT SELECT,INSERT,UPDATE ON public.season_predictions TO authenticated;
      CREATE POLICY "Anyone reads" ON public.season_predictions FOR SELECT USING(true);
      CREATE POLICY "Users create own" ON public.season_predictions FOR INSERT WITH CHECK(auth.uid()=user_id);
      CREATE POLICY "Users update own" ON public.season_predictions FOR UPDATE USING(auth.uid()=user_id);
      -- Explicit search_path lets the unchanged policy SQL bind a stable fixture
      -- clock. Production uses pg_catalog.now(); only time is injected here.
      CREATE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT current_setting('test.clock')::timestamptz $$;
      SET search_path = public, pg_catalog;
      SET test.clock = '2026-10-12 23:59:59+09';
    `);
    await db.exec(readFileSync('supabase/migrations/20261013_season_predictions_close.sql','utf8'));
    await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';`);
    const role = await db.query<{rolsuper:boolean;rolbypassrls:boolean}>("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    assert.deepEqual(role.rows,[{rolsuper:false,rolbypassrls:false}]);
    const upsert = (season:number,pick:string,category='winner') => db.query(
      `INSERT INTO public.season_predictions(user_id,season,category,pick) VALUES(auth.uid(),$1,$2,$3)
       ON CONFLICT(user_id,season,category) DO UPDATE SET pick=excluded.pick RETURNING pick`,[season,category,pick]);
    await upsert(2026,'LG');
    assert.equal((await upsert(2026,'KT')).rows[0].pick,'KT');
    console.log('PASS 1: pre-deadline insert and conflict-upsert');
    await db.exec("SET test.clock='2026-10-13 00:00:00+09'");
    await assert.rejects(upsert(2026,'LG','new-category'), /row-level security/i);
    await assert.rejects(upsert(2026,'LG'), /row-level security/i);
    const changed = await db.query("UPDATE public.season_predictions SET pick='LG' WHERE season=2026 RETURNING *");
    assert.equal(changed.rows.length,0);
    // Moving another season's row into the closed season must fail WITH CHECK.
    await upsert(2025,'SS');
    await assert.rejects(db.query("UPDATE public.season_predictions SET season=2026, category='moved' WHERE season=2025"), /row-level security/i);
    console.log('PASS 2: post-deadline insert/upsert denied; UPDATE touches zero; season-move denied');
    assert.equal((await upsert(2025,'NC')).rows[0].pick,'NC');
    assert.equal((await db.query("UPDATE public.season_predictions SET pick='HH' WHERE season=2025 RETURNING pick")).rows[0].pick,'HH');
    console.log('PASS 3: other season insert/update/upsert unaffected');
    assert.equal((await db.query("SELECT pick FROM public.season_predictions WHERE season=2026")).rows[0].pick,'KT');
    await db.exec("SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000002'");
    assert.equal((await db.query("SELECT pick FROM public.season_predictions WHERE season=2026")).rows[0].pick,'KT');
    console.log('PASS 4: existing SELECT preserved for original and second dedicated fixture identity');
  } finally { await db.close(); }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
