#!/usr/bin/env node
import playwright from "playwright";

const { chromium } = playwright;
const BASE_URL =
  process.argv.find((arg) => arg.startsWith("--base-url="))?.split("=")[1]
  ?? "http://localhost:3000";

const browser = await chromium.launch();

try {
  // slow-frame: 다음 poll이 시작돼 seq가 증가한 뒤 도착한 늦은 live frame은 적용되고,
  // 이후 더 새 live frame이 적용된 뒤 역순으로 도착한 오래된 frame은 폐기되어야 한다.
  {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      let requestCount = 0;
      window.__qaSlowFrameRequestCount = () => requestCount;
      window.fetch = (input, init = {}) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
        if (!url.includes("/api/game-relay")) return originalFetch(input, init);

        requestCount++;
        const currentRequest = requestCount;
        const parsed = new URL(url, window.location.origin);
        const include = parsed.searchParams.get("include");
        const encoder = new TextEncoder();

        // 시나리오 결속을 요청 순번이 아니라 의미(qa-game-a의 첫 include 요청)에 건다.
        // dev StrictMode 이중 마운트로 prime 경기 요청이 첫 순번을 먹는 레이스가 있었다.
        const isTargetGame = parsed.searchParams.get("gameId") === "qa-game-a";
        if (isTargetGame && include && include.includes("live") && !window.__qaSlowServed) {
          window.__qaSlowServed = true;
          const stream = new ReadableStream({
            start(controller) {
              const send = (payload, delayMs) => {
                setTimeout(() => {
                  controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
                }, delayMs);
              };
              send({
                channel: "relay",
                ok: true,
                status: 200,
                data: { gameId: "qa-game-a", innings: [], updatedAt: "relay-1" },
              }, 0);
              send({
                channel: "live",
                ok: true,
                status: 200,
                data: { updatedAt: "live-slow-accepted" },
              }, 3200);
              send({
                channel: "live",
                ok: true,
                status: 200,
                data: { updatedAt: "live-stale-dropped" },
              }, 12350);
              send({
                channel: "events",
                ok: true,
                status: 200,
                data: { events: [] },
              }, 12400);
              setTimeout(() => controller.close(), 12450);
            },
          });
          return Promise.resolve(new Response(stream, {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          }));
        }

        if (include && include.includes("live")) {
          return Promise.resolve(new Response([
            JSON.stringify({ channel: "relay", ok: true, status: 200, data: { gameId: "qa-game-a", innings: [], updatedAt: `relay-${currentRequest}` } }),
            JSON.stringify({ channel: "live", ok: true, status: 200, data: { updatedAt: "live-fresh" } }),
            "",
          ].join("\n"), {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          }));
        }

        if (parsed.pathname === "/api/game-relay-events") {
          return Promise.resolve(new Response([
            JSON.stringify({ channel: "relay", ok: true, status: 200, data: { gameId: "qa-game-a", innings: [], updatedAt: `relay-${currentRequest}` } }),
            JSON.stringify({ channel: "events", ok: true, status: 200, data: { events: [] } }),
            "",
          ].join("\n"), {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          }));
        }

        return Promise.resolve(new Response(JSON.stringify({
          gameId: "qa-game-a",
          innings: [],
          updatedAt: `relay-${currentRequest}`,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      };
    });
    await page.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() =>
      document.querySelector('[data-qa="live-frame-updated"]')?.textContent === "live-slow-accepted",
      null,
      { timeout: 6000 },
    );
    const acceptedCount = await page.locator('[data-qa="live-frame-count"]').textContent();
    if (acceptedCount !== "1") {
      throw new Error(`late live frame must apply after seq increases, got count ${acceptedCount}`);
    }
    await page.waitForFunction(() =>
      document.querySelector('[data-qa="live-frame-updated"]')?.textContent === "live-fresh",
      null,
      { timeout: 12000 },
    );
    await page.waitForTimeout(500);
    const finalLive = await page.locator('[data-qa="live-frame-updated"]').textContent();
    const finalLiveCount = await page.locator('[data-qa="live-frame-count"]').textContent();
    if (finalLive !== "live-fresh") {
      throw new Error(`stale reverse-order live frame overwrote newer frame: ${finalLive}`);
    }
    if (finalLiveCount !== "2") {
      throw new Error(`stale reverse-order live frame should be dropped, got count ${finalLiveCount}`);
    }
    const slowFrameRequests = await page.evaluate(() => window.__qaSlowFrameRequestCount());
    if (slowFrameRequests < 5) {
      throw new Error(`expected later live embed poll for stale-frame fencing, got ${slowFrameRequests} requests`);
    }
    await page.close();
  }

  // visibility-resume: hidden→visible 복귀는 fetch 1건만 날리고 include=live,detail 를 강제해야 한다.
  {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      const urls = [];
      window.__qaResumeUrls = () => urls.slice();
      window.fetch = (input, init = {}) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
        if (!url.includes("/api/game-relay")) return originalFetch(input, init);
        urls.push(url);
        const requestNo = urls.length;
        const parsed = new URL(url, window.location.origin);
        if (parsed.pathname === "/api/game-relay-events") {
          return Promise.resolve(new Response([
            JSON.stringify({ channel: "relay", ok: true, status: 200, data: { gameId: "qa-game-a", innings: [], updatedAt: `resume-relay-${requestNo}` } }),
            JSON.stringify({ channel: "events", ok: true, status: 200, data: { events: [] } }),
            JSON.stringify({ channel: "live", ok: true, status: 200, data: { updatedAt: `resume-live-${requestNo}` } }),
            JSON.stringify({ channel: "detail", ok: true, status: 200, data: { updatedAt: `resume-detail-${requestNo}` } }),
            "",
          ].join("\n"), {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          }));
        }

        return Promise.resolve(new Response(JSON.stringify({
          gameId: "qa-game-a",
          innings: [],
          updatedAt: `resume-relay-${requestNo}`,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      };
    });
    await page.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector('[data-qa="live-frame-count"]')?.textContent === "1");
    await page.waitForFunction(() => document.querySelector('[data-qa="detail-frame-count"]')?.textContent === "1");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    });
    await page.waitForTimeout(3200);
    const hiddenUrls = await page.evaluate(() => window.__qaResumeUrls());
    if (hiddenUrls.length !== 1) {
      throw new Error(`hidden state must suppress polling before resume, got ${hiddenUrls.length} requests`);
    }
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => document.querySelector('[data-qa="live-frame-count"]')?.textContent === "2");
    await page.waitForFunction(() => document.querySelector('[data-qa="detail-frame-count"]')?.textContent === "2");
    const resumeUrls = await page.evaluate(() => window.__qaResumeUrls());
    if (resumeUrls.length !== 2) {
      throw new Error(`visibility resume must issue exactly one fetch, got ${resumeUrls.length}`);
    }
    const resumeUrl = new URL(resumeUrls[1], BASE_URL);
    if (resumeUrl.searchParams.get("include") !== "live,detail") {
      throw new Error(`visibility resume must force include=live,detail, got ${resumeUrl.searchParams.get("include")}`);
    }
    await page.close();
  }

  console.log("game-relay hook UI: 2 passed, 0 failed");
} finally {
  await browser.close();
}
