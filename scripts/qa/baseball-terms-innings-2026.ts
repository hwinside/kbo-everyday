import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { answerQuestion, type QaDeps } from '../../src/lib/baseball-qa/pipeline';

type Row = { term: string; aliases: string[]; answer: string; category: string; source_kind: string; source_url: string; rule_version: string; reviewed_at: string };
const fixture = JSON.parse(fs.readFileSync('scripts/qa/fixtures/baseball-terms-innings-2026.json', 'utf8')) as { changes: {before: Row; after: Row}[] };
const migration = fs.readFileSync('supabase/migrations/20260911030000_baseball_terms_innings_2026.sql', 'utf8');
const rollback = fs.readFileSync('data/baseball-qa/baseball-terms-innings-2026.rollback.sql', 'utf8');
const unrelated = { ...fixture.changes[0].before, term: '무관한 항목', aliases: ['untouched'], answer: '이 행은 변경하지 않습니다.' };
async function setup(rows: Row[]) {
  const db = new PGlite();
  await db.exec(`CREATE TABLE public.baseball_terms (term text PRIMARY KEY, aliases text[], answer text, category text, source_kind text, source_url text, rule_version text, reviewed_at date)`);
  for (const r of rows) await db.query('INSERT INTO public.baseball_terms VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [r.term, r.aliases, r.answer, r.category, r.source_kind, r.source_url, r.rule_version, r.reviewed_at]);
  return db;
}
async function snapshot(db: PGlite) {
  return (await db.query<Row>('SELECT term, aliases, answer, category, source_kind, source_url, rule_version, reviewed_at::text FROM public.baseball_terms ORDER BY term')).rows;
}
async function main() {
  const inventory = JSON.parse(fs.readFileSync('scripts/qa/fixtures/baseball-terms-before-innings-20261105.json', 'utf8')) as Row[];
  for (const c of fixture.changes) assert.deepEqual(inventory.find(r => r.term === c.before.term), c.before, 'current production CAS prestate');
  const before = [...inventory, unrelated];
  const db = await setup(before);
  const initial = await snapshot(db);
  await db.exec(migration);
  const after = await snapshot(db);
  assert.deepEqual(after, initial.map(r => fixture.changes.find(c => c.before.term === r.term)?.after ?? r));
  await db.exec(migration);
  assert.deepEqual(await snapshot(db), after, 'reapply must be idempotent');
  let generated = 0;
  const deps: QaDeps = {
    loadGlossary: async () => after,
    loadPlayers: async () => [], getCache: async () => null, setCache: async () => {},
    callLlm: async () => { generated++; throw new Error('dictionary must not generate'); },
    reserveDaily: async () => ({allowed: true, remaining: 9}), log: async () => {},
  };
  for (const question of ['연장', '연장전', '무승부']) {
    const baseline = await answerQuestion('qa-innings-before', question, { ...deps, loadGlossary: async () => initial });
    assert.equal(baseline.source, 'dictionary');
    assert.match(baseline.answer, /12회/, 'current-main before reproduction');
    const result = await answerQuestion('qa-innings', question, deps);
    assert.equal(result.source, 'dictionary', question);
    assert.match(result.answer, /정규시즌 11회/);
    assert.match(result.answer, /포스트시즌 15회/);
    assert.doesNotMatch(result.answer, /12회/);
    assert.equal(result.answer, after.find(r => r.term === (question === '무승부' ? question : '연장전'))?.answer);
  }
  for (const question of ['APBC', '병살타', '삼중살']) {
    const base = await answerQuestion('qa-regression', question, { ...deps, loadGlossary: async () => initial });
    const head = await answerQuestion('qa-regression', question, deps);
    assert.equal(head.source, base.source, question);
    assert.equal(head.answer, base.answer, question);
  }
  assert.equal(generated, 0);
  await db.exec(rollback);
  assert.deepEqual(await snapshot(db), initial);
  await db.close();
  for (const changedField of ['answer', 'aliases', 'source_url'] as const) {
    const drift = before.map(r => r.term === '연장전' ? {...r, [changedField]: changedField === 'aliases' ? ['다른별칭'] : 'concurrent edit'} : r);
    const bad = await setup(drift);
    const original = await snapshot(bad);
    await assert.rejects(() => bad.exec(migration), /innings glossary drift/);
    await bad.exec('ROLLBACK');
    assert.deepEqual(await snapshot(bad), original, 'second-row drift must roll back first-row update');
    await bad.close();
  }
  const missing = await setup([fixture.changes[0].before, unrelated]);
  await assert.rejects(() => missing.exec(migration), /innings glossary missing term/);
  await missing.exec('ROLLBACK');
  await missing.close();
  console.log('PASS innings glossary: exact 2-row CAS, reapply, scoped rollback, drift atomicity, dictionary aliases 11/15');
}
main().catch(error => { console.error(error); process.exit(1); });
