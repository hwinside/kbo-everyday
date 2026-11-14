import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeFullEntryWithFreshness } from '../src/lib/stats/full-entry';
import { createCurrentSeasonRecordFetcher } from '../src/lib/baseball-qa/stats/current-season-source';
import { fetchServedCareerSnapshot } from '../src/lib/baseball-qa/stats/served-record';
import { resolveSeasonRecord, type SeasonRecordQuery } from '../src/lib/baseball-qa/stats/season-record';
import { FULL_ENTRY_BATTER_IDS, FULL_ENTRY_PITCHER_IDS } from '../src/lib/stats/full-entry-roster';
import { answerQuestion, type QaDeps } from '../src/lib/baseball-qa/pipeline';

const fresh = '2026-11-14T08:00:00Z';
const old = '2026-10-14T20:22:45.452Z';
const now = Date.parse('2026-11-14T08:30:00Z');
const query: SeasonRecordQuery = { table: 'batter', metric: 'hr', label: '홈런', kind: 'count' };

test('live and static players retain distinct freshness; stale runner cannot be refreshed', () => {
  const live = [{ kboId: '52605', name: '김도영', team: 'KIA', hr: 45 }];
  const statics = [...live.map(row => ({ ...row, hr: 40 })), { kboId: '99999', name: '테스트', team: 'KIA', hr: 0 }];
  const rows = mergeFullEntryWithFreshness(live, statics, fresh, old);
  assert.equal(rows[0].hr, 45);
  assert.equal(rows[0].recordUpdatedAt, fresh);
  assert.equal(rows[1].recordUpdatedAt, old);
  assert.equal(mergeFullEntryWithFreshness(live, statics, old, old)[0].recordUpdatedAt, old);
  assert.throws(() => mergeFullEntryWithFreshness(live, statics, fresh, 'invalid'));
  assert.throws(() => mergeFullEntryWithFreshness(live, statics, fresh, '2099-01-01T00:00:00Z'));
  assert.throws(() => mergeFullEntryWithFreshness([...live, ...live], statics, fresh, old), /duplicated/);
});

test('served current-player loader fixes stale envelope without relaxing career, identity or fallback guards', async () => {
  const originalFetch = globalThis.fetch;
  let recordAt: unknown = fresh;
  let corrupt = false;
  let calls = 0;
  globalThis.fetch = (async (url) => {
    calls++;
    const table = String(url).includes('type=pitcher') ? 'pitcher' : 'batter';
    const ids = table === 'batter' ? FULL_ENTRY_BATTER_IDS : FULL_ENTRY_PITCHER_IDS;
    const stats = ids.map((id, i) => ({ kboId: id, name: id === '52605' ? '김도영' : '테스트', team: 'KIA', hr: 45,
      ...(recordAt === undefined ? {} : { recordUpdatedAt: id === '52605' || (table === 'pitcher' && i === 0) ? recordAt : old }) }));
    if (corrupt) stats.pop();
    return new Response(JSON.stringify({ type: table, count: stats.length, updatedAt: old, stats }));
  }) as typeof fetch;
  const outcome = (rows: Awaited<ReturnType<ReturnType<typeof createCurrentSeasonRecordFetcher>>>) =>
    resolveSeasonRecord(rows, query, '52605', now, '김도영', 'KIA');
  const ask = () => answerQuestion('test-only', '김도영 올해 홈런 몇 개야?', {
    loadGlossary: async () => [],
    loadPlayers: async () => [{ kboId: '52605', name: '김도영', team: 'KIA', position: '내야수' }],
    getCache: async () => null, setCache: async () => {},
    callLlm: async () => { throw new Error('must not infer a number'); },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => {},
    getLlmState: async () => ({ started: false, result: null, ownerActive: false }),
    acquireLlmStart: async () => true, storeLlm: async () => {},
    now: () => now, enablePlayerRag: true,
    fetchCurrentSeasonRecord: createCurrentSeasonRecordFetcher(),
    fetchSeasonRecord: async () => { throw new Error('must not fall back to DB'); },
  } as unknown as QaDeps);
  try {
    const current = createCurrentSeasonRecordFetcher();
    const rows = await current('batter', '52605');
    assert.deepEqual(await current('batter', '52605'), rows);
    assert.equal(calls, 1);
    const answer = outcome(rows);
    assert.equal(answer.kind, 'ok');
    if (answer.kind === 'ok') assert.equal(answer.value, '45');
    const career = await fetchServedCareerSnapshot('batter');
    assert.equal(outcome(career.rows.filter(row => row.kbo_id === '52605')).kind, 'stale');
    assert.equal(career.updatedAt, old);
    const response = await ask();
    assert.equal(response.source, 'kbo_structured');
    assert.match(response.answer, /홈런.*45/);
    assert.match(response.answer, /2026/);
    const pitcher = await current('pitcher', FULL_ENTRY_PITCHER_IDS[0]);
    assert.equal(pitcher[0].updated_at, fresh);
    const staticId = FULL_ENTRY_BATTER_IDS.find(id => id !== '52605')!;
    assert.equal((await current('batter', staticId))[0].updated_at, old);
    assert.deepEqual(await current('batter', 'not-found'), []);
    assert.equal(outcome([{ ...rows[0], team: 'LG' }]).kind, 'inconsistent');
    for (const timestamp of [undefined, old]) {
      recordAt = timestamp;
      assert.equal(outcome(await createCurrentSeasonRecordFetcher()('batter', '52605')).kind, 'stale');
      const blocked = await ask();
      assert.equal(blocked.source, 'blocked');
      assert.doesNotMatch(blocked.answer, /45/);
    }
    recordAt = '2026-11-15T00:00:00Z';
    assert.equal(outcome(await createCurrentSeasonRecordFetcher()('batter', '52605')).kind, 'inconsistent');
    recordAt = 'invalid';
    await assert.rejects(createCurrentSeasonRecordFetcher()('batter', '52605'), /recordUpdatedAt/);
    recordAt = fresh;
    corrupt = true;
    await assert.rejects(createCurrentSeasonRecordFetcher()('batter', '52605'), /completeness/);
    await assert.rejects(createCurrentSeasonRecordFetcher()('pitcher', FULL_ENTRY_PITCHER_IDS[0]), /coverage/);
  } finally { globalThis.fetch = originalFetch; }
});
