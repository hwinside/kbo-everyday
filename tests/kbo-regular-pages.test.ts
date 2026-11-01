import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchRegularSeasonPages } from '../src/lib/crawler/kbo-regular-season';
const page = (n: number, series = '0') => `<input type="hidden" name="__VIEWSTATE" value="v${n}"><input type="hidden" name="__EVENTVALIDATION" value="e"><select name="x$ddlSeason"><option selected value="2026">2026</option></select><select name="x$ddlSeries"><option selected value="${series}">series</option></select><a id="ucPager_btnNo${n}" class="on">${n}</a>${n === 1 ? '<a id="ucPager_btnNo2" href="javascript:__doPostBack(&#39;x$ucPager$btnNo2&#39;,&#39;&#39;)">2</a>' : ''}<tbody><tr><td><a href="?playerId=${n}">player-${n}</a></td></tr></tbody>`;
test('all pages preserve season, series, cookie and refreshed form state', async () => {
 let calls=0;
 const fake=(async (_url, init)=>{
  calls++;
  if(calls===2){ const body=new URLSearchParams(String(init?.body)); assert.equal(body.get('x$ddlSeries'),'0');assert.equal(body.get('x$ddlSeason'),'2026');assert.equal(body.get('__VIEWSTATE'),'v1');assert.equal(new Headers(init?.headers).get('cookie'),'session=public-test'); }
  return new Response(page(calls),{headers:{'set-cookie':'session=public-test; Path=/'}});
 }) as typeof fetch;
 assert.equal((await fetchRegularSeasonPages('https://kbo.test/records',2026,AbortSignal.timeout(1000),fake)).length,2);
 assert.equal(calls,2);
});
test('middle failure, series drift and repeated page reject partial collection', async () => {
 for(const mode of ['http','series','repeat','duplicate']){
  let calls=0;
  const fake=(async()=>{calls++;return new Response(calls===1?page(1):mode==='repeat'?page(1):page(2,mode==='series'?'5':'0').replace(mode==='duplicate'?'playerId=2':'__never__','playerId=1'),{status:calls===2&&mode==='http'?503:200,headers:{'set-cookie':'session=public-test'}})}) as typeof fetch;
  await assert.rejects(fetchRegularSeasonPages('https://kbo.test/records',2026,AbortSignal.timeout(1000),fake));
 }
});
