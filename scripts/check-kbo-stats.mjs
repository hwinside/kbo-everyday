import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx', { waitUntil: 'networkidle', timeout: 30000 });
const title = await page.title();
console.log('Title:', title);
const content = await page.content();
console.log('Has tbody:', content.includes('tbody'));
const selects = await page.$$('select');
console.log('Selects count:', selects.length);
for (const s of selects) {
  const id = await s.getAttribute('id');
  console.log('  select id:', id);
}
await browser.close();
