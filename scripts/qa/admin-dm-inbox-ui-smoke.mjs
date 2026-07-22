#!/usr/bin/env node
import { chromium } from "playwright";
import { BASE } from "./_env.mjs";

const baseUrl = process.argv.find((arg) => arg.startsWith("--base-url="))?.split("=")[1] ?? BASE;
const adminPin = process.env.ADMIN_PIN;
if (!adminPin) {
  console.error("[admin-dm-inbox-ui] ADMIN_PIN is required");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const auth = await context.request.post(`${baseUrl}/api/admin/auth`, { data: { pin: adminPin } });
  check(auth.ok(), `admin auth failed: ${auth.status()}`);

  const page = await context.newPage();
  const started = performance.now();
  await page.goto(`${baseUrl}/admin/messages`, { waitUntil: "domcontentloaded" });
  await page.getByText(/\d+개 대화/).waitFor({ timeout: 5000 });
  const firstListMs = performance.now() - started;

  const cards = page.locator("button.glass-card");
  const firstPage = await cards.allTextContents();
  check(firstPage.length === 50, `first page expected 50 cards, got ${firstPage.length}`);
  check(firstListMs <= 1500, `first list exceeded 1.5s: ${firstListMs.toFixed(0)}ms`);

  let releaseAppend;
  let markAppendStarted;
  let silentDuringAppend = 0;
  const appendStarted = new Promise((resolve) => { markAppendStarted = resolve; });
  const appendRelease = new Promise((resolve) => { releaseAppend = resolve; });
  const appendHandler = async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("cursorAt")) {
      markAppendStarted();
      await appendRelease;
    } else {
      silentDuringAppend += 1;
    }
    await route.continue();
  };
  await page.route("**/api/admin/messages?tab=inbox*", appendHandler);

  await page.getByRole("button", { name: "이전 대화 더 보기" }).click();
  await appendStarted;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(100);
  check(silentDuringAppend === 0, "silent refresh started while append was pending");
  releaseAppend();
  await page.waitForFunction(() => document.querySelectorAll("button.glass-card").length > 50);
  await page.unroute("**/api/admin/messages?tab=inbox*", appendHandler);
  const afterAppend = await cards.allTextContents();
  check(afterAppend.length === 100, `append expected 100 cards, got ${afterAppend.length}`);
  check(
    firstPage.every((text, index) => afterAppend[index] === text),
    "older cursor page was prepended ahead of the latest page",
  );
  check(
    await page.getByRole("button", { name: "이전 대화 더 보기" }).isEnabled(),
    "append button remained stuck in loading state",
  );

  let releaseInbox;
  let markInboxStarted;
  const inboxStarted = new Promise((resolve) => { markInboxStarted = resolve; });
  const release = new Promise((resolve) => { releaseInbox = resolve; });
  await page.route("**/api/admin/messages?tab=inbox", async (route) => {
    markInboxStarted();
    await release;
    await route.continue();
  });

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await inboxStarted;
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/admin/messages?tab=sent") && response.ok()),
    page.getByRole("button", { name: "발송함" }).click(),
  ]);
  const sentHeader = page.getByText(/\d+건 발송 기록/);
  await sentHeader.waitFor({ timeout: 5000 });
  const sentCountBefore = await sentHeader.textContent();
  releaseInbox();
  await page.waitForTimeout(300);
  const sentCountAfter = await sentHeader.textContent();
  check(
    sentCountAfter === sentCountBefore,
    `stale inbox response overwrote the sent tab state: ${sentCountBefore} -> ${sentCountAfter}`,
  );
  check(await page.getByRole("button", { name: "발송함" }).getAttribute("class").then((value) => value?.includes("bg-[#6366F1]")), "sent tab lost active state");
  check(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth), "horizontal overflow detected");

  console.log(JSON.stringify({ checks, firstListMs: Math.round(firstListMs), firstPage: 50, afterAppend: 100 }));
} finally {
  await browser.close();
}
