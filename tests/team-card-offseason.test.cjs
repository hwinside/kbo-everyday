const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, dependencies, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, { exports, require: name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, ...globals });
  return exports;
}

async function routeFixture(date, slug = 'lg') {
  const months = [];
  const filters = [];
  const games = (month, count) => Array.from({ length: count }, (_, i) => ({
    date: `${month}-${String(i + 1).padStart(2, '0')}`, srId: '0', status: 'final',
    homeTeamId: 1, awayTeamId: 2, homeScore: 2, awayScore: 1,
  }));
  const query = new Proxy({}, { get: (_, key) => key === 'then'
    ? resolve => resolve({ data: [], count: 0 })
    : (...args) => { filters.push([key, ...args]); return query; } });
  class Clock extends Date { static now() { return new Date(date).getTime(); } }
  const route = load('src/app/api/team-card/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => ({ body, options }) } },
    '@/lib/crawler/kbo-api': { STANDINGS_SEASON: 2026, fetchStandings: async () => [{ teamId: 1, winRate: .6, gamesBehind: 0 }], teamCardRank: () => 1 },
    '@/lib/crawler/season-games-cache': { getMonthGames: async month => {
      months.push(month);
      // Final month has fewer than five regular games plus a postseason game.
      return [...games(month, (month.endsWith('-10') || month.endsWith('-05')) ? 2 : 5), { ...games(month, 1)[0], srId: '3', homeScore: 0 }];
    } },
    '@/lib/analysis/rank-history-selfheal': { appendLiveRankIfStale: (rows, day, rank) => [...rows, { date: day, rank }] },
    '@/lib/db/paginate': { fetchAllRows: async () => [] },
    '@/lib/analysis/weekly-team-rank': {},
    '@/lib/supabase/admin': { supabaseAdmin: { from: () => query } },
    '@/lib/constants/season': { REGULAR_SEASON_WINDOWS: { 2026: { start: '20260328', end: '20261012', finalized: true } } },
    '@/lib/constants/teams': { TEAMS: [{ id: 1, slug: 'lg' }] },
  }, { Date: Clock });
  const response = await route.GET({ nextUrl: new URL(`https://test/api/team-card?team=${slug}`) });
  return { ...response, months, filters };
}

for (const day of ['2026-11-09', '2026-12-31', '2027-01-15']) {
  test(`offseason ${day}: preserve final regular form and rank, no future-game dependency`, async () => {
    const f = await routeFixture(`${day}T03:00:00Z`);
    assert.deepEqual(f.months, ['2026-10', '2026-09']);
    assert.equal(f.body.recentForm.join(''), 'WWWWW');
    assert.equal(f.body.rankHistory.at(-1).date, '2026-10-12');
    assert.equal(f.body.nextGame, null);
    assert.ok(f.filters.some(x => x[0] === 'lte' && x[1] === 'date' && x[2] === '2026-10-12'));
  });
}
test('active season month-end does not overflow previous month', async () => {
  const f = await routeFixture('2026-05-31T03:00:00Z');
  assert.deepEqual(f.months, ['2026-05', '2026-04']);
  assert.equal(f.body.rankHistory.at(-1).date, '2026-05-31');
});
test('unknown team is rejected before data fetch', async () => {
  const f = await routeFixture('2026-11-09T03:00:00Z', 'unknown');
  assert.equal(f.options.status, 400);
  assert.equal(f.months.length, 0);
});

test('stalled card request leaves skeleton, shows retry, and recovers on retry', async () => {
  const React = require('react');
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://test/' });
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = require('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root'));
  let attempts = 0;
  let expire;
  let firstSignal;
  const Box = ({ children }) => React.createElement('div', null, children);
  const Empty = () => null;
  const Card = load('src/components/home/TeamCard.tsx', {
    react: React, 'react/jsx-runtime': require('react/jsx-runtime'),
    'next/link': Box,
    'lucide-react': { ChevronDown: Empty, ChevronRight: Empty, ChevronUp: Empty },
    '@/components/ui/GlassCard': Box, '@/components/ui/TeamLogo': Empty,
    '@/lib/constants/season': { isRegularSeasonFinal: () => true },
    '@/lib/stats/client-league-stats': { fetchLeagueStats: async () => [] },
    '@/lib/constants/teams': { getTeamById: () => null },
    '@/lib/utils/team': { getTeamColor: () => '#fff' },
    '@/lib/utils/resolve-player': {}, '@/lib/roster-moves/readiness': {},
    '@/lib/ui/result-tone': {},
  }, {
    AbortController,
    setTimeout: callback => { expire = callback; return 1; }, clearTimeout: () => {},
    fetch: async (url, options) => {
      if (!url.startsWith('/api/team-card')) return { ok: true, json: async () => ({ moves: [] }) };
      attempts++;
      if (attempts === 1) { firstSignal = options.signal; return new Promise(() => {}); }
      return { ok: true, json: async () => ({ standing: { rank: 4 }, recentForm: [] }) };
    },
  }).default;
  try {
    await React.act(async () => root.render(React.createElement(Card, { team: { id: 1, slug: 'lg', name: 'LG', shortName: 'LG' } })));
    assert.equal(attempts, 1);
    await React.act(async () => expire());
    assert.equal(firstSignal.aborted, true);
    assert.match(dom.window.document.body.textContent, /팀 기록을 불러오지 못했어요/);
    await React.act(async () => dom.window.document.querySelector('button').click());
    assert.equal(attempts, 2);
    assert.match(dom.window.document.body.textContent, /4위/);
    assert.doesNotMatch(dom.window.document.body.textContent, /불러오지 못했어요/);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    global.window = previousWindow;
    global.document = previousDocument;
    delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
