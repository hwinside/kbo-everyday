import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRegularSeasonHtml } from '../src/lib/crawler/kbo-regular-season';
const page = (year: number, series: number) => `<input type="hidden" name="__VIEWSTATE" value="v&amp;x"><input type="hidden" name="__EVENTVALIDATION" value="e"><select name="ctl$ddlSeason"><option selected="selected" value="${year}">${year}</option></select><select name="ctl$ddlSeries"><option selected="selected" value="${series}">series</option></select>`;
const url = 'https://www.koreabaseball.com/Record/Team/Hitter/Basic1.aspx';
test('PO empty page switches using form, carries cookie and verifies requested year', async () => {
  let calls = 0;
  const signal = new AbortController().signal;
  const fake = (async (_u, init) => {
    assert.equal(init?.signal, signal);
    calls++;
    if (calls === 1) return new Response(page(2026, 5), {headers:{'Set-Cookie':'ASP.NET_SessionId=abc; Path=/'}});
    const body = new URLSearchParams(String(init?.body));
    assert.equal(init?.method, 'POST');
    assert.equal(body.get('ctl$ddlSeason'), '2025');
    assert.equal(body.get('ctl$ddlSeries'), '0');
    assert.equal(body.get('__VIEWSTATE'), 'v&x');
    assert.equal(new Headers(init?.headers).get('Cookie'), 'ASP.NET_SessionId=abc');
    return new Response(page(2025, 0));
  }) as typeof fetch;
  await fetchRegularSeasonHtml(url, 2025, signal, fake);
  assert.equal(calls, 2);
});
for (const [year, series] of [[2025,0],[2026,5]]) test(`rejects returned wrong scope ${year}/${series}`, async () => {
  let calls=0;
  const fake = (async () => new Response(page(...(++calls === 1 ? [2026,5] : [year,series]) as [number,number]))) as typeof fetch;
  await assert.rejects(fetchRegularSeasonHtml(url, 2026, new AbortController().signal, fake), /selection mismatch/);
});
test('rejects error HTML instead of trusting HTTP 200', async () => {
  await assert.rejects(fetchRegularSeasonHtml(url,2026,new AbortController().signal,(async()=>new Response('error')) as typeof fetch), /controls missing/);
});
test('Basic2 is read only after Basic1 establishes regular season session', async () => {
  const calls: string[]=[];
  const fake = (async (u) => {calls.push(String(u)); return new Response(page(2026,calls.length===1?5:0),{headers:{'Set-Cookie':'ASP.NET_SessionId=abc; Path=/'}});}) as typeof fetch;
  await fetchRegularSeasonHtml(url.replace('Basic1','Basic2'),2026,new AbortController().signal,fake);
  assert.deepEqual(calls,[url,url,url.replace('Basic1','Basic2')]);
});
