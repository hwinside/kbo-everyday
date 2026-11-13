import { createKboPageAdapter, signatureOf } from './kbo-pagination.mjs';
import { createSelectAdapter, selectAndConfirm } from './kbo-select.mjs';

export const BASIC2_HEADERS = ['순위', '선수명', '팀명', 'AVG', 'BB', 'IBB', 'HBP', 'SO', 'GDP', 'SLG', 'OBP', 'OPS', 'MH', 'RISP', 'PH-BA'];

/**
 * Postseason direct entry redirects Basic2 -> BasicOld; selecting regular season
 * then redirects to Basic1. Re-enter Basic2 with the current page as Referer,
 * as the site's next-tab navigation does, retaining GAME_CN (all batters).
 * Never interpret Basic1/BasicOld cells as Basic2 or accept reset filters.
 */
export async function ensureBatterBasic2(page, season) {
  const adapter = createKboPageAdapter(page);
  for (const [suffix, value] of [['ddlSeries$ddlSeries', '0'], ['ddlSeason$ddlSeason', String(season)]]) {
    const selector = `select[name$='${suffix}']`;
    await selectAndConfirm(createSelectAdapter(page, selector, async () => signatureOf(await adapter.scrapeTable())), value, { label: `Basic2 ${suffix}` });
  }
  const path = '/Record/Player/HitterBasic/Basic2.aspx';
  const current = new URL(page.url());
  if (current.pathname !== path) {
    await page.goto(`${current.origin}${path}?sort=GAME_CN`, { referer: current.href, waitUntil: 'networkidle' });
  }
  const actual = new URL(page.url());
  const actualPath = actual.pathname;
  const series = await page.$eval("select[name$='ddlSeries$ddlSeries']", el => el.value);
  const actualSeason = await page.$eval("select[name$='ddlSeason$ddlSeason']", el => el.value);
  const sort = await page.$eval("input[name$='hfOrderByCol']", el => el.value);
  const headers = await page.$$eval('thead th', ths => ths.map(th => (th.textContent || '').trim()));
  if (actual.origin !== current.origin || actualPath !== path || series !== '0' || actualSeason !== String(season) || sort !== 'GAME_CN') {
    throw new Error(`basic2_context_mismatch: path=${actualPath} series=${series} season=${actualSeason} sort=${sort}`);
  }
  if (JSON.stringify(headers) !== JSON.stringify(BASIC2_HEADERS)) {
    throw new Error(`Basic2 header drift — 크롤 중단: ${JSON.stringify(headers)}`);
  }
}
