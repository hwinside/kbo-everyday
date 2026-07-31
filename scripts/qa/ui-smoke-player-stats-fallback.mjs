#!/usr/bin/env node
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
    await page.route("**/api/stats?type=batter**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          stats: staticBatters,
          type: "batter",
          count: staticBatters.length,
          source: "fallback",
          updatedAt: "2026-07-31T00:00:00.000Z",
        }),
      }),
    );
    await page.goto(`${BASE_URL}/teams/lg/player-records`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const body = await page.locator("body").innerText();
    const renderedName = lgPlayers.find((row) => body.includes(row.name))?.name;
    check("static fallback LG 선수 렌더", Boolean(renderedName), renderedName || "없음");
    check("빈 상태 미노출", !body.includes("기록이 아직 없습니다"));
    check("runtime error 0", runtimeErrors.length === 0, `count=${runtimeErrors.length}`);
    check("client-error telemetry 0", telemetry.length === 0, `count=${telemetry.length}`);
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
