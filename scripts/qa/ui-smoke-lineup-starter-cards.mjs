#!/usr/bin/env node
import assert from "node:assert/strict";
import playwright from "playwright";

const BASE_URL =
  process.argv.find((arg) => arg.startsWith("--base-url="))?.slice(11) ??
  "http://127.0.0.1:3000";
const GAME_ID = "20260731HHKT0";

const browser = await playwright.chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const runtimeErrors = [];
page.on("pageerror", (error) => runtimeErrors.push(error.message));

await page.route("**/api/game-live?**", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      games: [{
        gameId: GAME_ID,
        awayName: "한화",
        homeName: "KT",
        awayScore: 0,
        homeScore: 0,
        inning: 0,
        isTop: true,
        balls: 0,
        strikes: 0,
        outs: 0,
        runner1b: false,
        runner2b: false,
        runner3b: false,
        runner1bName: null,
        runner2bName: null,
        runner3bName: null,
        currentBatter: null,
        currentPitcher: null,
        currentInning: "",
        stadium: "수원",
        status: "scheduled",
        isLive: false,
        time: "18:30",
        awayStarterName: "류현진",
        homeStarterName: "소형준",
      }],
    }),
  }),
);
await page.route("**/api/game-detail?**", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      gameId: GAME_ID,
      status: "scheduled",
      meta: {
        stadium: "수원",
        crowd: null,
        startTime: "18:30",
        endTime: null,
        duration: null,
      },
      linescore: null,
      lineup: {
        isToday: false,
        awayStarter: "류현진",
        homeStarter: "소형준",
        away: Array.from({ length: 9 }, (_, index) => ({
          order: index + 1,
          position: "중견수",
          name: `과거원정${index + 1}`,
          avg: ".250",
        })),
        home: Array.from({ length: 9 }, (_, index) => ({
          order: index + 1,
          position: "중견수",
          name: `과거홈${index + 1}`,
          avg: ".250",
        })),
      },
      boxScore: null,
    }),
  }),
);
await page.route("**/api/game-relay?**", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ innings: [], linescore: null }),
  }),
);

try {
  await page.goto(`${BASE_URL}/games/${GAME_ID}?tab=lineup`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.getByText("류현진", { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText("소형준", { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText("타순은 라인업 확정 후 공개됩니다.", { exact: true }).waitFor();

  assert.equal(await page.getByText("과거원정1", { exact: true }).count(), 0);
  assert.equal(await page.getByText("과거홈1", { exact: true }).count(), 0);
  assert.deepEqual(runtimeErrors, []);
  console.log("lineup starter cards UI smoke: PASS (390x844, starters 2, stale batters 0, runtime 0)");
} finally {
  await browser.close();
}
