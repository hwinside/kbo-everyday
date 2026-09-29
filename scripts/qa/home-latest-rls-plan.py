#!/usr/bin/env python3
"""Developer PG17 regression: isolated synthetic data; never connects to production.
Run: npm run qa:home-latest-rls-plan:pg17
Uses an isolated local PG17 instance; stops its own instance on exit.
"""
import os, pathlib, re, subprocess, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[2]
BIN = pathlib.Path(os.environ['PGBIN'])
BASE = pathlib.Path(os.environ.get('PG_TEST_ROOT', tempfile.gettempdir()))
WORK = pathlib.Path(tempfile.mkdtemp(prefix='home-latest-pg.', dir=BASE))
# Unix socket only; no TCP listener and a short socket path under review root.
PORT = '59439'
def run(args, **kw):
    return subprocess.run([str(x) for x in args], check=True, text=True, capture_output=True, **kw).stdout

def sql(q):
    return run([BIN/'psql', '-X', '-h', WORK, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], input=q)

old = (ROOT/'supabase/migrations/20260908063000_home_team_latest_posts.sql').read_text()
new = (ROOT/'supabase/migrations/20260929094000_home_team_latest_posts_rls_plan.sql').read_text()
run([BIN/'initdb', '-D', WORK/'data', '-A', 'trust', '-U', 'postgres', '--locale=C', '--encoding=UTF8'])
started = False
try:
    run([BIN/'pg_ctl', '-D', WORK/'data', '-l', WORK/'server.log', '-o', f"-k {WORK} -p {PORT} -c listen_addresses=''", '-w', 'start'])
    started = True
    assert sql('show server_version_num;').strip().startswith('17')
    sql("""
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE stranger;
CREATE TABLE public.posts(id bigint PRIMARY KEY, author_id uuid NOT NULL,
  created_at timestamptz NOT NULL, is_hidden boolean, team_tags jsonb, player_tags jsonb);
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY public_read ON posts FOR SELECT USING (true);
CREATE POLICY author_update ON posts FOR UPDATE TO authenticated USING
  (author_id = nullif(current_setting('request.jwt.claim.sub', true),'')::uuid);
GRANT SELECT ON posts TO anon, authenticated;
INSERT INTO posts
SELECT i, CASE WHEN i % 13 = 0 THEN '00000000-0000-0000-0000-000000000002'::uuid
 ELSE '00000000-0000-0000-0000-000000000001'::uuid END,
 '2026-09-29 09:00Z'::timestamptz - (i/2)*interval '1 second',
 CASE WHEN i % 17 = 0 THEN true WHEN i % 19 = 0 THEN null ELSE false END,
 CASE WHEN i % 23 = 0 THEN '["kia","lg"]'::jsonb WHEN i % 29 = 0 THEN '["lg"]'::jsonb ELSE '["kia"]'::jsonb END,
 CASE WHEN i % 11 = 0 THEN '["other:Player"]'::jsonb ELSE '[]'::jsonb END
FROM generate_series(1,8000) i;
ANALYZE posts;
""")
    sql(old)
    cases = ["'kia',5", "'lg',5", "'kia',1000", "'kia',-1", "'kia',null", "null,5",
      "'kia',5,ARRAY['other'],ARRAY['00000000-0000-0000-0000-000000000002']::uuid[]",
      "'kia',5,'{}','{}','2026-09-29 08:59:57Z',6",
      "'kia',5,'{}','{}',null,6", "'kia',5,null,null"]
    def results():
        return {(r,c): sql(f'SET ROLE {r}; SELECT coalesce(jsonb_agg(t),\'[]\'::jsonb) FROM public.home_team_latest_posts({c}) t;')
          for r in ['anon','authenticated'] for c in cases}
    before = results()
    # Security precondition failures must leave the old function intact.
    for policy in ["DROP POLICY public_read ON posts; CREATE POLICY restricted_read ON posts FOR SELECT USING (NOT is_hidden);",
                   "CREATE POLICY restrictive_read ON posts AS RESTRICTIVE FOR SELECT USING (NOT is_hidden);"]:
        try:
            sql('BEGIN;'+policy+new+'ROLLBACK;')
        except subprocess.CalledProcessError as e:
            assert 'home latest definer' in e.stderr, e.stderr
        else:
            raise AssertionError('policy drift was not rejected')
    sql('BEGIN;'+new+'COMMIT;')
    assert results() == before, 'result/ordering changed across roles and boundary cases'
    assert sql("SELECT has_function_privilege('stranger','public.home_team_latest_posts(text,integer,text[],uuid[],timestamptz,bigint)','EXECUTE');").strip() == 'f'
    assert sql("SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp', 'plan_cache_mode=force_custom_plan'] FROM pg_proc WHERE oid='public.home_team_latest_posts(text,integer,text[],uuid[],timestamptz,bigint)'::regprocedure;").strip() == 't'
    # Capture the actual nested plan executed through each caller role.
    for role in ['anon','authenticated']:
        offset = (WORK/'server.log').stat().st_size
        sql(f"LOAD 'auto_explain'; SET auto_explain.log_min_duration=0; SET auto_explain.log_nested_statements=on; SET auto_explain.log_analyze=on; SET auto_explain.log_buffers=on; SET plan_cache_mode=force_generic_plan; SET ROLE {role}; SELECT id FROM public.home_team_latest_posts('kia',5); SELECT id FROM public.home_team_latest_posts('kia',5); SELECT current_setting('plan_cache_mode');")
        log = (WORK/'server.log').read_text()[offset:]
        assert 'Index Scan using posts_home_team_latest_idx' in log, log
        assert 'Sort ' not in log, log
        inner_buffers = re.findall(r'Limit[^\n]*\n\s*Buffers: shared hit=(\d+)', log)
        assert len(inner_buffers) == 2 and all(int(n) < 100 for n in inner_buffers), log
        (WORK/f'{role}-plan.log').write_text(log)
    # A caller temp table cannot shadow the schema-qualified relation.
    assert sql("SET ROLE anon; CREATE TEMP TABLE posts(id bigint); SELECT count(*) FROM public.home_team_latest_posts('kia',5);").strip() == '5'
    # Explicit rollback restores identical contract and invoker security.
    sql(old)
    assert results() == before
    print('PASS: 20 role/input equivalence cases, policy-drift rejection, ACL, pinned search_path, temp shadow, nested index/no Sort, rollback')
    print(f'Evidence: {WORK}')
finally:
    if started:
        run([BIN/'pg_ctl', '-D', WORK/'data', '-m', 'fast', '-w', 'stop'])
