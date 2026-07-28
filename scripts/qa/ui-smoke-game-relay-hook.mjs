#!/usr/bin/env node
import playwright from "playwright";

const { chromium } = playwright;
const BASE_URL =
  process.argv.find((arg) => arg.startsWith("--base-url="))?.split("=")[1]
  ?? "http://localhost:3000";

const browser = await chromium.launch();
try {
  let fetchCount = 0;
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
  await page.close();

  let delayedFetchCount = 0;
  let releaseInitialFetch;
  const initialFetchGate = new Promise((resolve) => {
    releaseInitialFetch = resolve;
  });
  const delayedPage = await browser.newPage();
  await delayedPage.route("**/api/game-relay?*", async (route) => {
    delayedFetchCount++;
    if (delayedFetchCount === 1) await initialFetchGate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ innings: [], updatedAt: `delayed-fetch-${delayedFetchCount}` }),
    });
  });
  await delayedPage.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "domcontentloaded" });
  await delayedPage.waitForFunction(() => document.querySelector('[data-qa="relay-status"]')?.textContent === "live");
  await delayedPage.locator('[data-qa="finish-game"]').click();
  await delayedPage.waitForFunction(() => document.querySelector('[data-qa="relay-status"]')?.textContent === "final");
  releaseInitialFetch();
  await delayedPage.waitForFunction(() => document.querySelector('[data-qa="relay-updated"]')?.textContent === "delayed-fetch-2");
  if (delayedFetchCount !== 2) {
    throw new Error(`in-flight live→final expected terminal retry, got ${delayedFetchCount} fetches`);
  }
  await delayedPage.close();

  // ---- A→B gameId 전환: 캐시/폴카운터 초기화 + 교차 오염 차단(삼순 blocker ②) ----
  {
    const reqUrls = [];
    const inning = { inning: 1, half: "top", teamName: "A", plays: [] };
    const switchPage = await browser.newPage();
    await switchPage.route("**/api/game-relay?*", async (route) => {
      const url = route.request().url();
      reqUrls.push(url);
      const gid = new URL(url).searchParams.get("gameId");
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ gameId: gid, innings: [inning], updatedAt: `${gid}-${reqUrls.length}` }),
      });
    });
    await switchPage.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "networkidle" });
    await switchPage.waitForFunction(() => document.querySelector('[data-qa="relay-game"]')?.textContent === "qa-game-a");
    const aReqCount = reqUrls.length;
    // 첫 A 요청은 since 없는 full
    if (reqUrls.some((u) => u.includes("gameId=qa-game-a") && u.includes("since="))) {
      throw new Error("first A fetch must be full (no since)");
    }
    // 전환
    await switchPage.locator('[data-qa="switch-game"]').click();
    await switchPage.waitForFunction(() => document.querySelector('[data-qa="relay-game"]')?.textContent === "qa-game-b");
    const bUrls = reqUrls.slice(aReqCount).filter((u) => u.includes("gameId=qa-game-b"));
    if (bUrls.length === 0) throw new Error("switch to B did not fetch B");
    // B 첫 요청은 캐시·폴카운터 초기화로 since 가 없어야 한다(이전 경기 이닝 위 delta 병합 차단)
    if (bUrls[0].includes("since=")) {
      throw new Error("first B fetch leaked since from previous game cache");
    }
    await switchPage.close();

    // in-flight 가드: A 응답을 지연시키고 그 사이 B로 전환 → 늦게 도착한 A 응답은 setData 하지 않음
    let releaseA;
    const aGate = new Promise((r) => { releaseA = r; });
    const inflightUrls = [];
    const inflightPage = await browser.newPage();
    await inflightPage.route("**/api/game-relay?*", async (route) => {
      const url = route.request().url();
      inflightUrls.push(url);
      const gid = new URL(url).searchParams.get("gameId");
      if (gid === "qa-game-a") await aGate; // A 응답 보류
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ gameId: gid, innings: [inning], updatedAt: `${gid}-live` }),
      });
    });
    await inflightPage.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "domcontentloaded" });
    await inflightPage.waitForFunction(() => document.querySelector('[data-qa="relay-status"]')?.textContent === "live");
    // A 요청이 보류된 상태에서 B로 전환
    await inflightPage.locator('[data-qa="switch-game"]').click();
    await inflightPage.waitForFunction(() => document.querySelector('[data-qa="relay-game"]')?.textContent === "qa-game-b");
    // 이제 보류했던 A 응답 릴리즈 → 늦게 도착해도 B를 덮어쓰면 안 된다
    releaseA();
    await inflightPage.waitForTimeout(150);
    const shownGame = await inflightPage.locator('[data-qa="relay-game"]').textContent();
    if (shownGame !== "qa-game-b") {
      throw new Error(`stale A in-flight response overwrote B (shown: ${shownGame})`);
    }
    await inflightPage.close();
  }

  console.log("game-relay hook UI: 7 passed, 0 failed");
} finally {
  await browser.close();
}
