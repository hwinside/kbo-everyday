#!/usr/bin/env node
import playwright from "playwright";

const { chromium } = playwright;
const BASE_URL =
  process.argv.find((arg) => arg.startsWith("--base-url="))?.split("=")[1]
  ?? "http://localhost:3000";

let fetchCount = 0;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route("**/api/game-relay?*", async (route) => {
    fetchCount++;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ innings: [], updatedAt: `fetch-${fetchCount}` }),
    });
  });
  await page.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "networkidle" });
  if (fetchCount !== 1) throw new Error(`live initial fetch expected 1, got ${fetchCount}`);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  });
  await page.locator('[data-qa="finish-game"]').click();
  await page.waitForTimeout(50);
  if (fetchCount !== 1) throw new Error(`hidden final transition fetched unexpectedly: ${fetchCount}`);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(() => document.querySelector('[data-qa="relay-updated"]')?.textContent === "fetch-2");
  if (fetchCount !== 2) throw new Error(`visible final retry expected 2 total fetches, got ${fetchCount}`);

  console.log("game-relay hook UI: 3 passed, 0 failed");
} finally {
  await browser.close();
}
