import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx?sort=HRA_RT");
await page.waitForLoadState("networkidle");

// Debug: check tables
const tables = await page.$$eval("table", (ts) =>
  ts.map((t) => ({ class: t.className, rows: t.querySelectorAll("tbody tr").length }))
);
console.log("Tables:", JSON.stringify(tables));

// Current season
const season = await page
  .$eval("select[name$='ddlSeason']", (el) => el.value)
  .catch(() => "not found");
console.log("Season:", season);

// Try multiple selectors
const selectors = ["table.tData tbody tr", "tbody tr", ".record_result tbody tr", "#tblRecord tbody tr"];
for (const sel of selectors) {
  const count = await page.$$eval(sel, (rows) => rows.length).catch(() => 0);
  console.log(`${sel}: ${count} rows`);
}

// Get page HTML snippet around table
const snippet = await page.evaluate(() => {
  const tbody = document.querySelector("tbody");
  return tbody ? tbody.innerHTML.slice(0, 500) : "no tbody found";
});
console.log("Tbody snippet:", snippet);

await browser.close();
