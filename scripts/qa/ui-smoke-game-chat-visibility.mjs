import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:3057";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

try {
  await page.goto(`${baseUrl}/games/20260328-LG-DS`, { waitUntil: "networkidle" });
  const hide = page.getByRole("button", { name: "전체 채팅 끄기" });
  await hide.waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-composer="game-chat"]').count(), 1, "ON이면 composer가 있어야 한다");

  await hide.click();
  await page.getByRole("button", { name: "전체 채팅 켜기" }).waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-composer="game-chat"]').count(), 0, "OFF면 composer DOM이 없어야 한다");
  assert.equal(await page.locator("text=전체 채팅").count(), 0, "OFF면 채팅 header도 없어야 한다");

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "전체 채팅 켜기" }).waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-composer="game-chat"]').count(), 0, "비로그인 OFF 설정은 reload 후 유지되어야 한다");

  await page.getByRole("button", { name: "전체 채팅 켜기" }).click();
  await page.getByRole("button", { name: "전체 채팅 끄기" }).waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-composer="game-chat"]').count(), 1, "ON 복귀 시 composer가 다시 생겨야 한다");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "390px 가로 overflow가 없어야 한다");

  console.log("ui-smoke-game-chat-visibility: PASS (ON→OFF→reload→ON, 390px)");
} finally {
  await browser.close();
}
