// Execution / verdict belong to the reviewer:
// node scripts/qa/game-reviews-concurrency.mjs
// Requires local PostgreSQL 17 tools and OPENCLAW_REVIEW_ROOT. Creates its own
// Unix-socket-only cluster; never accepts a DB URL or uses production credentials.
// Each race proves a second backend is blocked before releasing the first.
// NOT an HTTP/load benchmark: latency, 50->200-user spikes and End-User QA remain separate.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.OPENCLAW_REVIEW_ROOT;
assert.ok(root && path.isAbsolute(root), 'Set OPENCLAW_REVIEW_ROOT to the approved review volume');
const candidates = [process.env.GAME_REVIEWS_PGBIN, '/opt/homebrew/opt/postgresql@17/bin', '/usr/local/opt/postgresql@17/bin'].filter(Boolean);
let bin;
for (const candidate of candidates) {
  try { for (const tool of ['initdb', 'pg_ctl', 'psql']) await fs.access(path.join(candidate, tool), fs.constants.X_OK); bin = candidate; break; } catch { /* try next installation */ }
}
assert.ok(bin, 'Local PostgreSQL tools missing; set GAME_REVIEWS_PGBIN (no DB URL)');
// Only non-secret process essentials; ignore all inherited PG* connection settings.
const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' };
const work = await fs.mkdtemp(path.join(root, 'gr-race.'));
const data = path.join(work, 'data'), socket = path.join(work, 'sock');
assert.ok(Buffer.byteLength(socket) < 80, 'Review root too long for a PostgreSQL Unix socket');
await fs.mkdir(socket);
const active = new Set();
function start(tool, args, input) {
  const child = spawn(path.join(bin, tool), args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { child, out: '', err: '', exited: false };
  active.add(child);
  child.stdout.setEncoding('utf8').on('data', s => { state.out += s; });
  child.stderr.setEncoding('utf8').on('data', s => { state.err += s; });
  // A failed psql may close stdin while a cleanup command is being written.
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') state.err += error.message; });
  state.done = new Promise(resolve => {
    child.once('error', error => { state.err += error.message; });
    child.once('close', code => { state.exited = true; state.code = code; active.delete(child); resolve(state); });
  });
  if (input !== undefined) child.stdin.end(input);
  return state;
}
async function success(job) {
  const result = await job.done;
  assert.equal(result.code, 0, result.err || result.out);
  return result.out.trim();
}
const args = ['-X', '-q', '-t', '-A', '--no-password', '-h', socket, '-p', '55487', '-U', 'qa', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
const timeoutSql = "SET statement_timeout='15s'; SET lock_timeout='10s';";
function sql(text) { return success(start('psql', args, `${timeoutSql}\n${text}\n`)); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 8000;
  do { if (await predicate()) return; await delay(25); } while (Date.now() < deadline);
  throw new Error(`Barrier timeout: ${label}`);
}
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const game = '20260907SSLG0';
function mutate(actor, op, options = '') {
  return `SELECT gr_mutate('${uid(actor)}','${game}','${op}',away=>8,home=>1,winner=>1,p_allow_recreate=>false,p_nomination_mode=>'optional_winner_participant'${options ? ',' + options : ''});`;
}
const results = [];
async function race(label, first, second, error = null) {
  const holder = start('psql', args);
  holder.child.stdin.write(`${timeoutSql}\nSET application_name='${label}_first'; SET ROLE service_role; BEGIN;\n${first}\n\\echo HOLDER_READY\n`);
  let contender;
  try {
    await until(() => {
      assert.ok(!holder.exited, holder.err || 'holder exited before barrier');
      return holder.out.includes('HOLDER_READY');
    }, label);
    contender = start('psql', args, `${timeoutSql}\nSET application_name='${label}_second'; SET ROLE service_role; BEGIN;\n${second}\nCOMMIT;\n`);
    await until(async () => {
      assert.ok(!contender.exited, `contender did not wait: ${contender.err}`);
      return await sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${label}_second' AND wait_event_type='Lock';`) === '1';
    }, `${label}: independent lock waiter`);
    assert.equal(await sql(`SELECT count(DISTINCT pid) FROM pg_stat_activity WHERE application_name IN('${label}_first','${label}_second');`), '2');
    holder.child.stdin.end('COMMIT;\n');
    await success(holder);
    const result = await contender.done;
    if (error) {
      assert.notEqual(result.code, 0, 'expected rejection');
      assert.ok(result.err.includes(error), result.err);
    } else assert.equal(result.code, 0, result.err);
  } finally {
    if (!holder.exited) holder.child.stdin.end('ROLLBACK;\n');
    await holder.done;
    if (contender) await contender.done;
  }
}
async function reset() {
  await sql(`TRUNCATE game_reviews,game_review_comments,game_review_likes,game_review_rate_limits,reports,report_blind_notices RESTART IDENTITY CASCADE;`);
}
async function seed() { await reset(); await sql(`SET ROLE service_role; ${mutate(1, 'create', "body=>'original'")}`); }
async function check(label, body) { await body(); results.push({ label, status: 'PASS' }); console.log(`PASS ${label}`); }
let running = false, watchdog;
try {
  await success(start('initdb', ['-D', data, '-A', 'trust', '-U', 'qa', '--locale=C', '--encoding=UTF8'], ''));
  // Paths are generated locally, but pg_ctl's server options are shell-parsed.
  const quotedSocket = "'" + socket.replaceAll("'", "'\\''") + "'";
  await success(start('pg_ctl', ['-D', data, '-l', path.join(work, 'postgres.log'), '-o', `-p 55487 -k ${quotedSocket} -c listen_addresses=''`, '-w', 'start'], ''));
  running = true;
  watchdog = setTimeout(() => { for (const child of active) child.kill('SIGTERM'); }, 120_000);
  await sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE profiles(id uuid PRIMARY KEY,team_id integer,nickname text);
    CREATE TABLE user_blocks(blocker_id uuid,blocked_id uuid);
    CREATE TABLE reports(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,reporter_id uuid,target_type text,target_id bigint,reason text,detail text,UNIQUE(reporter_id,target_type,target_id));
    ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
    CREATE TABLE report_blind_notices(target_type text,target_id bigint,author_id uuid,UNIQUE(target_type,target_id));
    GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;`);
  await sql(await fs.readFile(new URL('../../supabase/migrations/20260907000001_game_reviews.sql', import.meta.url), 'utf8'));
  await sql(`INSERT INTO profiles VALUES ${Array.from({ length: 6 }, (_, i) => `('${uid(i + 1)}',1,'fixture${i + 1}')`).join(',')};`);
  await check('same actor create / create', async () => {
    await reset();
    await race('create', mutate(1, 'create', "body=>'first'"), mutate(1, 'create', "body=>'second'"), 'gr_exists');
    assert.equal(await sql('SELECT count(*) FROM game_reviews;'), '1');
  });
  await check('same actor different edits consume one edit', async () => {
    await seed();
    await race('edit', mutate(1, 'edit', "rid=>1,body=>'first edit'"), mutate(1, 'edit', "rid=>1,body=>'second edit'"), 'gr_edit_expired');
    assert.equal(await sql('SELECT content||\'|\'||edit_count FROM game_reviews WHERE id=1;'), 'first edit|1');
  });
  await check('same desired like is idempotent / one quota event', async () => {
    await seed();
    await race('like_retry', mutate(2, 'like', 'rid=>1,desired=>true'), mutate(2, 'like', 'rid=>1,desired=>true'));
    assert.equal(await sql('SELECT like_count FROM game_reviews WHERE id=1;'), '1');
    assert.equal(await sql(`SELECT cardinality(hits) FROM game_review_rate_limits WHERE actor_id='${uid(2)}' AND action='like';`), '1');
  });
  await check('different actors like / like preserve counter', async () => {
    await seed();
    await race('like_distinct', mutate(2, 'like', 'rid=>1,desired=>true'), mutate(3, 'like', 'rid=>1,desired=>true'));
    assert.equal(await sql('SELECT like_count=(SELECT count(*) FROM game_review_likes) AND like_count=2 FROM game_reviews WHERE id=1;'), 't');
  });
  await check('like / unlike serialize desired state', async () => {
    await seed();
    await race('like_unlike', mutate(2, 'like', 'rid=>1,desired=>true'), mutate(2, 'like', 'rid=>1,desired=>false'));
    assert.equal(await sql('SELECT like_count FROM game_reviews WHERE id=1;'), '0');
    assert.equal(await sql('SELECT count(*) FROM game_review_likes;'), '0');
  });
  await check('quota boundary accepts only twentieth mutation', async () => {
    await seed();
    await sql(`INSERT INTO game_review_rate_limits(actor_id,action,hits) VALUES('${uid(2)}','like',array_fill(clock_timestamp(),ARRAY[19]));`);
    await race('quota', mutate(2, 'like', 'rid=>1,desired=>true'), mutate(2, 'like', 'rid=>1,desired=>false'), 'gr_rate');
    assert.equal(await sql('SELECT like_count FROM game_reviews WHERE id=1;'), '1');
    assert.equal(await sql(`SELECT cardinality(hits) FROM game_review_rate_limits WHERE actor_id='${uid(2)}' AND action='like';`), '20');
  });
  for (const kind of ['delete', 'hide']) await check(`${kind} / comment denies stale parent write`, async () => {
    await seed();
    const first = kind === 'delete' ? mutate(1, 'delete', 'rid=>1') : "SELECT gr_moderate('game_review',1,true);";
    await race(kind, first, mutate(2, 'comment', "rid=>1,body=>'late',body_key=>'late'"), 'gr_missing');
    assert.equal(await sql('SELECT count(*) FROM game_review_comments;'), '0');
    const feed = JSON.parse(await sql(`SET ROLE service_role; SELECT gr_feed('${game}',p_best_min_likes=>3);`));
    assert.equal(feed.total, 0); assert.equal(feed.rows.length, 0); assert.equal(feed.best.length, 0);
  });
  await check('parallel second / third reports hide once', async () => {
    await seed();
    const report = actor => `SELECT gr_report('${uid(actor)}','game_review',1,'광고·도배');`;
    await sql(`SET ROLE service_role; ${report(2)}`);
    await race('reports', report(3), report(4));
    assert.equal(await sql('SELECT is_hidden FROM game_reviews WHERE id=1;'), 't');
    assert.equal(await sql('SELECT count(*) FROM report_blind_notices;'), '1');
  });
  console.log(`${results.length}/${results.length} independent-connection scenarios PASS (not load/E2E)`);
} catch (error) {
  results.push({ status: 'FAIL', error: error.message });
  process.exitCode = 1;
  console.error(error.message);
} finally {
  clearTimeout(watchdog);
  for (const child of active) child.kill('SIGTERM');
  await fs.writeFile(path.join(work, 'result.json'), JSON.stringify({ script: fileURLToPath(import.meta.url), results, load: 'NOT_RUN', endUser: 'NOT_RUN' }, null, 2));
  if (running) {
    const stop = await start('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], '').done;
    if (stop.code !== 0) { process.exitCode = 1; console.error('Temporary cluster stop failed; inspect evidence directory'); }
    else await fs.rm(data, { recursive: true, force: true });
  }
  console.log(`Evidence: ${work}`);
}
