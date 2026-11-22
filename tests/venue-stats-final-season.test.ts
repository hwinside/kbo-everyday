import assert from 'node:assert/strict';
import test from 'node:test';
import type { KboGame } from '../src/lib/crawler/kbo-api';
import { createVerifiedSourceCache } from '../src/lib/venue-stats/source-cache';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://venue-stats-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

const codes = ['LG','OB','KT','SK','NC','HT','LT','SS','HH','WO'];
function fullSeason(): KboGame[] {
  const result: KboGame[] = [];
  for (let a = 0; a < 10; a++) for (let b = a + 1; b < 10; b++) {
    for (let day = 1; day <= 16; day++) {
      const date = `202604${String(day).padStart(2, '0')}`;
      result.push({gameId: `${date}${codes[a]}${codes[b]}0`, date, status:'final',
        awayTeamId:a+1, homeTeamId:b+1, awayScore:5, homeScore:3} as KboGame);
    }
  }
  return result;
}

test('closed-season completeness requires exact official season volume, team counts, identities and scores', async () => {
  const {hasCompleteFinalSeasonSchedule: complete} = await import('../src/lib/crawler/season-games-cache');
  const full = fullSeason();
  assert.equal(complete(2026,'2026-11-22',full),true);
  assert.equal(complete(2026,'2026-10-12',full),false);
  assert.equal(complete(2027,'2027-11-22',full),false);
  assert.equal(complete(2026,'2026-11-22',full.slice(1)),false);
  const change = (patch: Partial<KboGame>) => [{...full[0],...patch},...full.slice(1)];
  for (const patch of [ {awayScore: undefined}, {homeScore:-1}, {awayTeamId:3},
    {gameId:full[1].gameId}, {date:'20260301'}, {status:'live' as const} ]) {
    assert.equal(complete(2026,'2026-11-22',change(patch)),false);
  }
  const imbalanced = change({gameId:`${full[0].date}KTSS1`, awayTeamId:3,homeTeamId:8});
  assert.equal(complete(2026,'2026-11-22',imbalanced),false);
});

test('public-source cache coalesces success, never retains partial/error and expires', async () => {
  let now = 1000;
  const original = Date.now;
  Date.now = () => now;
  const cache = createVerifiedSourceCache<number[]>(v => v.length === 2, 100, 2);
  let calls = 0;
  const healthy = async () => {calls++;return [1,2];};
  try {
    await Promise.all([cache('ok',healthy), cache('ok',healthy)]);
    assert.equal(calls,1);
    await cache('ok',healthy);
    assert.equal(calls,1);
    now += 101;
    await cache('ok',healthy);
    assert.equal(calls,2);
    await cache('partial',async()=>[1]);
    assert.deepEqual(await cache('partial',healthy),[1,2]);
    await assert.rejects(cache('fail',async()=>{throw new Error('unavailable');}));
    assert.deepEqual(await cache('fail',healthy),[1,2]);
  } finally {Date.now = original;}
});
