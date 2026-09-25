"""Disposable local PG17 cluster only; pass its Unix socket and unused database.
Runs 163,434 PV + 145,590 dwell fixtures, real 8s statement timeout, locks,
role denial and phase audits. No production connectivity or credentials.
"""
import argparse
import json
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--socket', required=True)
parser.add_argument('--port', default='55439')
parser.add_argument('--database', default='postgres')
parser.add_argument('--bin', default='/opt/homebrew/opt/postgresql@17/bin')
args = parser.parse_args()
assert args.socket.startswith('/'), 'local Unix socket required'
base = [f'{args.bin}/psql', '-X', '-qAt', '-h', args.socket, '-p', args.port,
        '-d', args.database, '-v', 'ON_ERROR_STOP=1']

def sql(query, failure=None):
    result = subprocess.run(base, input=query, text=True, capture_output=True, timeout=60)
    if failure:
        assert result.returncode != 0 and failure in result.stderr, result.stderr
        return
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()

assert sql('SHOW server_version').startswith('17.'), 'PG17 required'
assert sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'") == '0', 'empty disposable DB required'
fixture = Path('scripts/qa/admin-telemetry-retention-batches-db.ts').read_text().split('    await db.exec(`',1)[1].split('`);',1)[0]
fixture = fixture.split('    INSERT INTO admin_page_views',1)[0]
for role in ['anon', 'authenticated', 'service_role']:
    if sql(f"SELECT count(*) FROM pg_roles WHERE rolname='{role}'") == '1':
        fixture=fixture.replace(f'CREATE ROLE {role};', '')
sql(fixture)
# A retained-policy-relative oldest day; all rows in the same KST day. Insert
# BEFORE rollup migrations so the backfill exercises real aggregate creation.
sql("""
INSERT INTO admin_page_views(created_at,path,platform,visitor_id)
SELECT ((now() AT TIME ZONE 'Asia/Seoul')::date-31)::timestamp AT TIME ZONE 'Asia/Seoul'
       + (i%86400)*interval '1 second', '/home', 'web', 'v'||(i%10000)
FROM generate_series(1,163434) i;
INSERT INTO admin_page_dwell(created_at,platform,visitor_id,dwell_ms)
SELECT ((now() AT TIME ZONE 'Asia/Seoul')::date-31)::timestamp AT TIME ZONE 'Asia/Seoul'
       + (i%86400)*interval '1 second', 'web', 'v'||(i%10000),1000
FROM generate_series(1,145590) i;
""")
for name in ['20260721_admin_traffic_page_view_rollup.sql',
             '20260721_admin_traffic_dwell_rollup.sql',
             '20260722_admin_telemetry_retention.sql',
             '20260918_telemetry_retention_preview_scan.sql',
             '20260925_telemetry_retention_kind_batches.sql']:
    sql('BEGIN;\n'+Path('supabase/migrations',name).read_text()+'\nCOMMIT;')
sql('ANALYZE;')
ref = "'supabase-physical:1@'||clock_timestamp()::text"
batch = f"SELECT admin_telemetry_retention_batch(true,{ref});"
for lock, expected, request in [
    ("SELECT pg_advisory_xact_lock(hashtextextended('admin_telemetry_retention',0));", 'already running', batch),
    ('LOCK TABLE admin_page_views IN ROW EXCLUSIVE MODE;', 'could not obtain lock', batch),
    ('LOCK TABLE admin_page_views IN ROW EXCLUSIVE MODE;', 'could not obtain lock',
     f'SELECT admin_telemetry_retention_rollups({ref});'),
]:
    locker = subprocess.Popen(base, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    locker.stdin.write('BEGIN;\n'+lock+'\n\\echo READY\nSELECT pg_sleep(2);\nROLLBACK;\n')
    locker.stdin.close()
    while True:
        line = locker.stdout.readline()
        assert line != '', 'lock holder failed'
        if 'READY' in line: break
    started = time.monotonic()
    sql("SET statement_timeout='8s';"+request, expected)
    assert time.monotonic()-started < 1.5, 'lock conflict must fail without waiting'
    assert locker.wait(timeout=5) == 0
assert sql('SELECT count(*) FROM admin_telemetry_retention_runs') == '0'
sql('SET ROLE anon; SELECT admin_telemetry_retention_batch(false,NULL);', 'permission denied')
sql(f'SELECT admin_telemetry_retention_rollups({ref});', 'raw batches remain')
results=[]
for kind,count in [('pageViews',163434),('pageDwell',145590)]:
    started=time.monotonic()
    body=json.loads(sql("SET statement_timeout='8s';"+batch))
    elapsed=round((time.monotonic()-started)*1000)
    assert body['rawKind']==kind and body['deleted'][kind]==count, body
    results.append({'kind':kind,'rows':count,'ms':elapsed,'audit':body['auditId']})
assert json.loads(sql(batch))['done'] is True
sql(f"SET statement_timeout='8s';SELECT admin_telemetry_retention_rollups({ref});")
assert sql('SELECT count(*) FROM admin_telemetry_retention_runs')=='3'
print(json.dumps({'result':'PASS','batches':results,'locks':'NOWAIT/advisory PASS','role':'anon denied','timeout':'8s unchanged'}))
