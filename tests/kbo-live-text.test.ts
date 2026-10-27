import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadKboLiveText, parseKboLiveText, type RedisCommand } from '../src/lib/crawler/kbo-live-text';
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://smoke.local';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'smoke-anon-key';
const gameId = '20261027HTSS0';
const v1 = readFileSync(new URL('./fixtures/kbo-live/view1.html', import.meta.url), 'utf8');
const v2 = readFileSync(new URL('./fixtures/kbo-live/view2.html', import.meta.url), 'utf8');

test('official live fixture preserves innings, pending batter, pitches and actual stats', async () => {
  const { parseInningRelays } = await import('../src/app/api/game-relay/route');
  const snapshot = parseKboLiveText(gameId, v1, v2);
  const innings = parseInningRelays(snapshot.rows);
  assert.deepEqual(innings.map(i => [i.inning, i.half, i.plays.length]), [[1, 'top', 3], [1, 'bottom', 3], [2, 'top', 4], [2, 'bottom', 1]]);
  assert.equal(innings[1].plays[2].batterName, '구자욱');
  assert.equal(innings[1].plays[2].type, 'strikeout');
  assert.equal(innings[1].plays[2].pitches?.length, 7);
  assert.equal(innings[3].currentAtBat?.batterName, '최형우');
  assert.equal(snapshot.boxScore.awayBatters.length, 9);
  assert.ok(snapshot.boxScore.awayPitchers[0].pitchCount > 0);
  assert.equal(snapshot.linescore.away.innings[8], null);
});
test('blank, truncated, changed tables fail closed instead of successful empty payload', () => {
  assert.throws(() => parseKboLiveText(gameId, v1, ''));
  assert.throws(() => parseKboLiveText(gameId, v1.replaceAll('tblScoreBoard2', 'changed'), v2));
  assert.throws(() => parseKboLiveText(gameId, v1, v2.replaceAll('병살', 'changed')));
});
test('PO1 actual pinch hitters and defensive replacements retain all late-inning at-bats', async () => {
  const { parseInningRelays } = await import('../src/app/api/game-relay/route');
  const score = readFileSync(new URL('./fixtures/kbo-live/po1-view1.html', import.meta.url), 'utf8');
  const text = readFileSync(new URL('./fixtures/kbo-live/po1-view2.html', import.meta.url), 'utf8');
  const snapshot = parseKboLiveText('20261026HTSS0', score, text);
  const innings = parseInningRelays(snapshot.rows);
  const bottom8 = innings.find(i => i.inning === 8 && i.half === 'bottom')!;
  const top9 = innings.find(i => i.inning === 9 && i.half === 'top')!;
  assert.deepEqual(bottom8.plays.map(p => p.batterName), ['김영웅', '김현준', '김도환']);
  assert.deepEqual(top9.plays.map(p => p.batterName), ['김태군', '박민', '박정우']);
  assert.ok(bottom8.plays[1].pitches?.length);
  assert.ok(top9.plays[0].pitches?.length);
  assert.equal(bottom8.plays[1].batOrder, 8);
  assert.equal(bottom8.plays[2].batOrder, 9);
  assert.ok(snapshot.rows.flatMap(r => r.textOptions ?? []).filter(o => o.type === 8).every(o => !o.text.includes('교체')));
  assert.ok(snapshot.rows.some(r => r.title.includes('대타 김도환 : 2루수 김상준')));
});
test('same-length scorer correction replaces original result', async () => {
  const { parseInningRelays } = await import('../src/app/api/game-relay/route');
  const corrected = parseInningRelays(parseKboLiveText(gameId, v1, v2.replace('구자욱 : 삼진 아웃', '구자욱 : 볼넷')).rows);
  assert.equal(corrected[1].plays[2].type, 'walk');
});
function harness(fail = false) {
  const cache = new Map<string, string>(); let fetches = 0;
  const command: RedisCommand = async a => {
    if (a[0] === 'GET') return cache.get(String(a[1])) ?? null;
    if (a[0] === 'SET') { if (cache.has(String(a[1]))) return null; cache.set(String(a[1]), String(a[2])); return 'OK'; }
    if (a[0] === 'EVAL') { assert.equal(cache.get(String(a[3])), a[5]); cache.set(String(a[4]), String(a[6])); return 'OK'; }
    throw new Error('unexpected Redis command');
  };
  const fetcher = (async (url: string | URL | Request) => {
    fetches++; if (fail) throw new Error('upstream unavailable');
    return new Response(String(url).includes('View1') ? v1 : v2);
  }) as typeof fetch;
  return { command, fetcher, count: () => fetches };
}
test('100 simultaneous cold callers admit only one two-view collection; warm readers fetch zero', async () => {
  const h = harness();
  const results = await Promise.allSettled(Array.from({ length: 100 }, () => loadKboLiveText(gameId, { ...h, srId: '5' })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(h.count(), 2);
  await loadKboLiveText(gameId, { ...h, srId: '5' });
  assert.equal(h.count(), 2);
});
test('failure keeps shared cooldown closed and Redis failure never bypasses admission', async () => {
  const h = harness(true);
  await assert.rejects(loadKboLiveText(gameId, { ...h, srId: '5' }));
  await assert.rejects(loadKboLiveText(gameId, { ...h, srId: '5' }));
  assert.equal(h.count(), 2);
  const command: RedisCommand = async () => { throw new Error('Redis unavailable'); };
  await assert.rejects(loadKboLiveText(gameId, { ...h, command, srId: '5' }));
  assert.equal(h.count(), 2);
});
test('caller deadline is shared by Redis and both KBO views without another timer', async (t) => {
  const h = harness(); const ac = new AbortController();
  const timeout = t.mock.method(AbortSignal, 'timeout', () => { throw new Error('unexpected nested deadline'); });
  const command: RedisCommand = async (args, signal) => {
    assert.equal(signal, ac.signal);
    return h.command(args, signal);
  };
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(init?.signal, ac.signal);
    return h.fetcher(url, init);
  };
  await loadKboLiveText(gameId, { command, fetcher, srId: '5', signal: ac.signal });
  assert.equal(h.count(), 2);
  assert.equal(timeout.mock.callCount(), 0);
});
test('standalone collection retains one 2800ms deadline shared across all IO', async (t) => {
  const h = harness(); const ac = new AbortController();
  const timeout = t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, 2800);
    return ac.signal;
  });
  const command: RedisCommand = async (args, signal) => {
    assert.equal(signal, ac.signal);
    return h.command(args, signal);
  };
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(init?.signal, ac.signal);
    return h.fetcher(url, init);
  };
  await loadKboLiveText(gameId, { command, fetcher, srId: '5' });
  assert.equal(timeout.mock.callCount(), 1);
});
test('aborted collection cannot publish snapshot', async () => {
  const h = harness(); const ac = new AbortController();
  const fetcher = (async () => { ac.abort(); return new Response(v2); }) as typeof fetch;
  await assert.rejects(loadKboLiveText(gameId, { ...h, fetcher, srId: '5', signal: ac.signal }));
});
test('wrong-date HTML and old/mismatched cache are rejected', async () => {
  assert.throws(() => parseKboLiveText(gameId, v1, v2.replace('2026-10-27', '2026-10-26')));
  const snapshot = parseKboLiveText(gameId, v1, v2);
  for (const cached of [{ ...snapshot, updatedAt: '2026-01-01T00:00:00Z' }, { ...snapshot, gameId: '20261026HTSS0' }]) {
    const command: RedisCommand = async a => a[0] === 'GET' ? JSON.stringify(cached) : null;
    await assert.rejects(loadKboLiveText(gameId, { command, srId: '5' }));
  }
});
test('expired admission cannot return or persist a late successful snapshot', async () => {
  const h = harness();
  const command: RedisCommand = async (args, signal) => args[0] === 'EVAL' ? null : h.command(args, signal);
  await assert.rejects(loadKboLiveText(gameId, { ...h, command, srId: '5' }), /publish failed/);
});
