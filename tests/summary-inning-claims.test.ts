import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import { hasUnsupportedPlayerInning, hasVerifiedInningClaims } from '../src/lib/game-summary/inning-claims';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://summary.test';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-only';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';

test('blocks invented inning/player ties in all fields including MVP implied subject', () => {
  for (const summary of [
    { headline: '문보경의 1회 2점 홈런' },
    { gameFlow: { early: '1회 LG가 앞섰다. 문보경이 투런포를 날렸다.' } },
    { mvpBatter: { name: '문보경', reason: '3회 역전포로 승리를 이끌었다.' } },
    { insight: '첫 이닝에 문보경이 앞장섰다.' },
    { unexpectedField: '문보경이 연장 회에 타점을 올렸다.' },
  ]) assert.equal(hasUnsupportedPlayerInning(summary, ['문보경']), true);
  assert.equal(hasUnsupportedPlayerInning({ headline: 'LG, 3회 2점으로 역전', mvpBatter: { name: '문보경', stats: '4타수 2안타 1홈런', reason: '경기 전체 3타점' } }, ['문보경']), false);
  assert.equal(hasUnsupportedPlayerInning({ headline: '원태인 7이닝 무실점' }, ['원태인']), false);
  assert.equal(hasVerifiedInningClaims({ headline: 'old' }), false);
});

test('actual public GET hides unverified/unsafe cache and strips internal evidence on safe cache', async () => {
  const { GET } = await import('../src/app/api/game-summary/route');
  const original = globalThis.fetch;
  try {
    for (const mode of ['legacy', 'unsafe', 'empty-roster-unsafe', 'safe']) {
      const summary = { headline: mode.includes('unsafe') ? '문보경의 1회 2점 홈런' : 'LG 역전승', ...(mode === 'legacy' ? {} : { _verifiedPlayerNames: mode === 'empty-roster-unsafe' ? [] : ['문보경'] }) };
      globalThis.fetch = (async () => Response.json({ summary, prompt_version: 15 })) as typeof fetch;
      const response = await GET(new NextRequest('https://summary.test/api/game-summary?gameId=20261026LGHT0'));
      const body = await response.json();
      if (mode === 'safe') { assert.equal(body.summary.headline, 'LG 역전승'); assert.equal(body.summary._verifiedPlayerNames, undefined); }
      else assert.equal(body.summary, null);
    }
  } finally { globalThis.fetch = original; }
});

test('empty roster cannot verify inning prose but inning-free summary remains available', () => {
  for (const names of [[], [' ', '']]) {
    assert.equal(hasUnsupportedPlayerInning({ headline: '문보경의 1회 투런' }, names), true);
    assert.equal(hasUnsupportedPlayerInning({ mvpBatter: { name: '문보경', reason: '3회 역전포' } }, names), true);
    assert.equal(hasUnsupportedPlayerInning({ headline: 'LG 승리' }, names), false);
  }
  assert.equal(hasVerifiedInningClaims({ headline: '문보경의 1회 투런', _verifiedPlayerNames: [] }), false);
  assert.equal(hasVerifiedInningClaims({ headline: 'LG 승리', _verifiedPlayerNames: [] }), true);
});
