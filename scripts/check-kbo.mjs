import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('https://www.koreabaseball.com/Record/Player/Search.aspx', { waitUntil: 'networkidle', timeout: 30000 });

const selects = await page.$$eval('select', els => els.map(e => ({ id: e.id, name: e.name, optCount: e.options.length })));
console.log('Selects:', JSON.stringify(selects, null, 2));

const teamEl = await page.$('select#ddlTeam');
console.log('ddlTeam found:', !!teamEl);

// Try alternative selectors
const allSelects = await page.$$('select');
for (const s of allSelects) {
  const id = await s.getAttribute('id');
  const name = await s.getAttribute('name');
  console.log(`Select: id=${id}, name=${name}`);
}

await browser.close();
