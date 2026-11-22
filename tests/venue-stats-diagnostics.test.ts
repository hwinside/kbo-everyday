import assert from 'node:assert/strict';
import test from 'node:test';
import type { KboGame } from '../src/lib/crawler/kbo-api';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://venue-stats-test.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

test('failed collection logs bounded diagnostics, skips RPC, and recovers without caching failure', async () => {
  const { fetchSeasonAggregates, __resetSeasonAggregatesCaches } = await import('../src/app/api/me/venue-stats/route');
  __resetSeasonAggregatesCaches();
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  let rpcCalls = 0;
  let fetchCalls = 0;
  let healthy = false;
  const deps = {
    fetcher: async (date: string) => {
      fetchCalls++;
      if (!healthy && date === '20260330') throw new Error('private-upstream-error');
      return {
        games: date === '20260328' ? [{ gameId: '20260328LGOB0', date, time: '18:30', status: 'final', awayTeamId: 1, homeTeamId: 2, awayScore: 5, homeScore: 3 } as KboGame] : [],
        emptyVerified: true,
      };
    },
    rpc: async (args: {p_games: Array<{gameId: string; gameDate: string}>}) => {
      rpcCalls++;
      return {data: { games: args.p_games.map(g => ({...g, complete: false})), teams: [] }, error: null};
    },
  };
  try {
    const failed = await fetchSeasonAggregates(2026, deps);
    assert.equal(failed.seasonGames, null);
    assert.equal(rpcCalls, 0);
    assert.equal(warnings.length, 1);
    const details = warnings[0][1] as Record<string, unknown>;
    assert.equal(details.reason, 'schedule_incomplete');
    assert.equal(details.failedDates, 1);
    assert.equal(JSON.stringify(warnings).includes('private-upstream-error'), false);
    healthy = true;
    const recovered = await fetchSeasonAggregates(2026, deps);
    assert.equal(recovered.seasonGames?.length, 1);
    assert.equal(recovered.officialScoresComplete, true);
    const callsAfterRecovery = fetchCalls;
    await fetchSeasonAggregates(2026, deps);
    assert.equal(fetchCalls, callsAfterRecovery);
    assert.equal(rpcCalls, 1);
  } finally {
    console.warn = original;
    __resetSeasonAggregatesCaches();
  }
});

test('unexpected request failures return controlled 500 without logging raw error', async () => {
  const route = await import('../src/app/api/me/venue-stats/route');
  const {NextRequest} = await import('next/server');
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args) => {errors.push(args);};
  route.__setVenueStatsRouteRuntimeDepsForTests({getVerifiedUser: async () => {throw new Error('private-auth-error');}});
  try {
    const response = await route.GET(new NextRequest('https://test.invalid/api/me/venue-stats?season=2026'));
    assert.equal(response.status, 500);
    assert.equal(errors.length, 1);
    assert.equal((errors[0][1] as Record<string, unknown>).reason, 'unhandled_dependency');
    assert.equal(JSON.stringify(errors).includes('private-auth-error'), false);
  } finally {
    console.error = original;
    route.__setVenueStatsRouteRuntimeDepsForTests(null);
  }
});
