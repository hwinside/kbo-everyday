import assert from 'node:assert/strict';
import test from 'node:test';


test('KBO fallback preserves source ranks including ties and non-rank row order', async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://test.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-only';
  const { fetchStandings } = await import('../src/lib/crawler/kbo-api');
  const nativeFetch = globalThis.fetch;
  const row = (rank: string, name: string) => `<tr>${[rank,name,144,80,60,4,'.571',0].map(v => `<td>${v}</td>`).join('')}</tr>`;
  let calls = 0;
  globalThis.fetch = (async (input) => {
    calls++;
    if (String(input).includes('api-gw.sports.naver.com')) return new Response('', {status:503});
    assert.match(String(input), /TeamRank.aspx/);
    return new Response(`<table>${row('2','LG')}${row('2','두산')}${row('1','KT')}</table>`);
  }) as typeof fetch;
  try {
    const result = await fetchStandings();
    assert.deepEqual(result.map(r => [r.teamId,r.ranking]), [[1,2],[2,2],[3,1]]);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
