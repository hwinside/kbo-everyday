#!/usr/bin/env node
// @crawl-managed-read: structural  (크롤 관리 데이터 파일을 구조·불변식 검증에만 사용 — 값 하드코딩 금지, 축② 순환참조 메타게이트)
/**
 * PR #1003: malformed Naver 200이 서버에서 static fallback으로 닫힌 뒤에도
 * 팀 선수 기록 화면이 빈 상태로 퇴화하지 않는지 390×844 실브라우저로 고정한다.
 */
import fs from "node:fs";
import playwright from "playwright";

const { chromium } = playwright;
const BASE_URL =
  process.argv.find((arg) => arg.startsWith("--base-url="))?.split("=")[1] ||
  "http://localhost:3003";
const staticBatters = JSON.parse(
  fs.readFileSync("src/lib/constants/stats-2026-batters.json", "utf8"),
);
const staticPitchers = JSON.parse(
  fs.readFileSync("src/lib/constants/stats-2026-pitchers.json", "utf8"),
);
const canonicalBatters = staticBatters.map((row) =>
  row.name === "페라자"
    ? { ...row, kboId: "FP003", playerId: "FP003" }
    : row,
);
const canonicalPitchers = staticPitchers.map((row) =>
  row.name === "미야지"
    ? { ...row, kboId: "AQ003", playerId: "AQ003" }
    : row,
);
const lgPlayers = staticBatters.filter((row) => row.team === "LG");
if (lgPlayers.length === 0) throw new Error("static batter fallback has no LG players");

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "  ✅" : "  ❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const runtimeErrors = [];
    const telemetry = [];
    page.on("pageerror", (error) => runtimeErrors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") runtimeErrors.push(message.text());
    });
    page.on("request", (request) => {
      if (/client-error|telemetry/.test(request.url())) telemetry.push(request.url());
    });
    await page.route("**/api/stats?type=**", (route) => {
      const isPitcher = new URL(route.request().url()).searchParams.get("type") === "pitcher";
      const stats = isPitcher ? canonicalPitchers : canonicalBatters;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          stats,
          type: isPitcher ? "pitcher" : "batter",
          count: stats.length,
          source: "naver-fallback",
          updatedAt: "2026-07-31T00:00:00.000Z",
        }),
      });
    });
    await page.goto(`${BASE_URL}/teams/lg/player-records`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const body = await page.locator("body").innerText();
    const renderedName = lgPlayers.find((row) => body.includes(row.name))?.name;
    check("static fallback LG 선수 렌더", Boolean(renderedName), renderedName || "없음");
    check("빈 상태 미노출", !body.includes("기록이 아직 없습니다"));
    check("runtime error 0", runtimeErrors.length === 0, `count=${runtimeErrors.length}`);
    check("client-error telemetry 0", telemetry.length === 0, `count=${telemetry.length}`);
    await page.goto(`${BASE_URL}/teams/hanwha/player-records`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const perazaLink = page.locator('a[href="/community/players/FP003"]');
    check(
      "Naver 페라자 numeric ID → FP003 링크·렌더",
      (await perazaLink.count()) > 0 && (await page.locator("body").innerText()).includes("페라자"),
    );
    await page.goto(`${BASE_URL}/teams/samsung/player-records`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "투수", exact: true }).click();
    await page.waitForTimeout(500);
    const miyajiLink = page.locator('a[href="/community/players/AQ003"]');
    check(
      "Naver 미야지 numeric ID → AQ003 링크·렌더",
      (await miyajiLink.count()) > 0 && (await page.locator("body").innerText()).includes("미야지"),
    );
    await context.close();
  } finally {
    await browser.close();
  }
  console.log(
    `player-stats fallback UI smoke: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
