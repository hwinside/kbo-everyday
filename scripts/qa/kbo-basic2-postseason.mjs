import assert from 'node:assert/strict';
import { ensureBatterBasic2, BASIC2_HEADERS } from '../lib/kbo-basic2.mjs';

const base = 'https://www.koreabaseball.com/Record/Player/HitterBasic/';
function fake({ healthy = false, fault } = {}) {
  let url = `${base}${healthy ? 'Basic2' : 'BasicOld'}.aspx?sort=GAME_CN`;
  let series = healthy ? '0' : '5';
  let season = '2026';
  let sort = 'GAME_CN';
  let headers = healthy ? BASIC2_HEADERS : ['G', 'PA', 'AB'];
  const navigations = [];
  return {
    navigations,
    url: () => url,
    async $eval(selector, fn) {
      const value = selector.includes('ddlSeries') ? series : selector.includes('ddlSeason') ? season : sort;
      return fn({ value });
    },
    async $$eval(selector, fn) {
      if (selector === 'thead th') return fn(headers.map(textContent => ({ textContent })));
      return [{ texts: [series, season, url], hrefs: [] }];
    },
    async selectOption(selector, value) {
      if (fault === 'lost-postback') return;
      if (selector.includes('ddlSeries')) { series = value; url = `${base}Basic1.aspx?sort=GAME_CN`; }
      else season = value;
    },
    async waitForLoadState() {}, async waitForTimeout() {},
    async goto(target, options) {
      navigations.push({ target, options });
      assert.equal(options.referer, url, 'retain selected source context');
      assert.equal(options.waitUntil, 'networkidle');
      assert.match(target, /Basic2.aspx\?sort=GAME_CN$/);
      if (fault !== 'wrong-page') url = target;
      headers = fault === 'header-drift' ? ['G', 'PA', 'AB'] : BASIC2_HEADERS;
      if (fault === 'season-reset') season = '2025';
      if (fault === 'series-reset') series = '5';
      if (fault === 'sort-reset') sort = 'HRA_RT';
    },
  };
}
const fixed = fake();
await ensureBatterBasic2(fixed, '2026');
assert.equal(fixed.navigations.length, 1);
const prior = fake();
await ensureBatterBasic2(prior, '2025');
assert.equal(prior.navigations.length, 1);
const normal = fake({ healthy: true });
await ensureBatterBasic2(normal, '2026');
assert.equal(normal.navigations.length, 0);
for (const fault of ['lost-postback', 'wrong-page', 'season-reset', 'series-reset', 'sort-reset', 'header-drift']) {
  await assert.rejects(() => ensureBatterBasic2(fake({ fault }), '2026'), /transition_incomplete|context_mismatch|header drift/, fault);
}
console.log('Basic2 postseason: 3 valid paths + 6 fail-close boundaries passed');
