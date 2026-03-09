import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx?sort=HRA_RT");
await page.waitForLoadState("networkidle");

// Check paging HTML
const pagingHtml = await page.evaluate(() => {
  const paging = document.querySelector(".paging") || document.querySelector("[class*='paging']");
  return paging ? paging.outerHTML : "no paging found";
});
console.log("Paging HTML:", pagingHtml.slice(0, 1000));

// Check total rows count text
const totalText = await page.evaluate(() => {
  const spans = [...document.querySelectorAll("span")];
  return spans.map(s => s.textContent).filter(t => /\d+명/.test(t) || /total/i.test(t));
});
console.log("Total:", totalText);

await browser.close();
