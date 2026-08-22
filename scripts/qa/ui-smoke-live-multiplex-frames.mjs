#!/usr/bin/env node
import playwright from "playwright";

const { chromium } = playwright;
const BASE_URL =
  process.argv.find((arg) => arg.startsWith("--base-url="))?.split("=")[1]
  ?? "http://localhost:3000";

const browser = await chromium.launch();

try {
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

        const isTargetGame = parsed.searchParams.get("gameId") === "qa-game-a";
        if (isTargetGame && include && include.includes("live") && !window.__qaSlowServed) {
          window.__qaSlowServed = true;
          const stream = new ReadableStream({
            start(controller) {
              const send = (payload, delayMs) => {
                setTimeout(() => {
                  if (payload.data?.updatedAt === "live-slow-accepted") {
                    window.__qaSlowDelivered = true;
                  }
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
          const frames = [
            JSON.stringify({
              channel: "relay",
              ok: true,
              status: 200,
              data: { gameId: "qa-game-a", innings: [], updatedAt: `relay-${currentRequest}` },
            }),
          ];
          if (window.__qaSlowDelivered) {
            frames.push(JSON.stringify({ channel: "live", ok: true, status: 200, data: { updatedAt: "live-fresh" } }));
          }
          if (include.includes("events")) {
            frames.push(JSON.stringify({ channel: "events", ok: true, status: 200, data: { events: [] } }));
          }
          return Promise.resolve(new Response([...frames, ""].join("\n"), {
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
    if (slowFrameRequests < 4) {
      throw new Error(`expected 9s live cadence to reach a later embed poll, got ${slowFrameRequests} requests`);
    }
    await page.close();
  }

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
        const include = (parsed.searchParams.get("include") ?? "").split(",").filter(Boolean);
        const frames = [
          JSON.stringify({ channel: "relay", ok: true, status: 200, data: { gameId: "qa-game-a", innings: [], updatedAt: `resume-relay-${requestNo}` } }),
        ];
        if (include.includes("events")) {
          frames.push(JSON.stringify({ channel: "events", ok: true, status: 200, data: { events: [] } }));
        }
        if (include.includes("live")) {
          frames.push(JSON.stringify({ channel: "live", ok: true, status: 200, data: { updatedAt: `resume-live-${requestNo}` } }));
        }
        if (include.includes("detail")) {
          frames.push(JSON.stringify({ channel: "detail", ok: true, status: 200, data: { updatedAt: `resume-detail-${requestNo}` } }));
        }
        return Promise.resolve(new Response([...frames, ""].join("\n"), {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
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

  {
    // 시나리오 3 (삼순 6차): 실패 live/detail frame 은 커밋하지 않는다 —
    // last-good 보존 + seq 미소유 + 이후 성공 frame 정상 복구.
    // include 없는 3초 poll 은 legacy JSON 경로라 frame 을 안 태운다(1차 설계의
    // 검출력 0 원인). visibility resume 이 include=live,detail 을 강제하는 것을
    // 이용해 실패 embed 를 결정론적으로 2번째 embed 에 싣는다.
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      let embeds = 0;
      window.__qaFailFlowEmbeds = () => embeds;
      window.fetch = (input, init = {}) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
        if (!url.includes("/api/game-relay")) return originalFetch(input, init);
        const parsed = new URL(url, window.location.origin);
        const include = (parsed.searchParams.get("include") ?? "").split(",").filter(Boolean);
        if (include.length === 0) {
          return Promise.resolve(new Response(JSON.stringify({ gameId: "qa-game-a", innings: [], updatedAt: "ff-relay-plain" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        }
        embeds++;
        const embedNo = embeds;
        const failed = embedNo === 2;
        const frames = [
          JSON.stringify({ channel: "relay", ok: true, status: 200, data: { gameId: "qa-game-a", innings: [], updatedAt: `ff-relay-${embedNo}` } }),
        ];
        if (include.includes("events")) {
          frames.push(JSON.stringify({ channel: "events", ok: true, status: 200, data: { events: [] } }));
        }
        if (include.includes("live")) {
          frames.push(failed
            ? JSON.stringify({ channel: "live", ok: false, status: 503, data: { error: "starter witness unavailable", games: [] } })
            : JSON.stringify({ channel: "live", ok: true, status: 200, data: { updatedAt: `ff-live-${embedNo}` } }));
        }
        if (include.includes("detail")) {
          frames.push(failed
            ? JSON.stringify({ channel: "detail", ok: false, status: 503, data: { error: "detail unavailable" } })
            : JSON.stringify({ channel: "detail", ok: true, status: 200, data: { updatedAt: `ff-detail-${embedNo}` } }));
        }
        return Promise.resolve(new Response([...frames, ""].join("\n"), {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        }));
      };
    });
    await page.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() =>
      document.querySelector('[data-qa="live-frame-updated"]')?.textContent === "ff-live-1"
      && document.querySelector('[data-qa="detail-frame-updated"]')?.textContent === "ff-detail-1",
      null, { timeout: 10000 });
    const forceResume = async () => {
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    };
    // embed 2 = 실패 frame — 소비 확인 후 last-good·seq 미소유 판정
    await forceResume();
    await page.waitForFunction(() => window.__qaFailFlowEmbeds() >= 2, null, { timeout: 8000 });
    await page.waitForTimeout(700);
    const liveAfterFail = await page.locator('[data-qa="live-frame-updated"]').textContent();
    const liveCountAfterFail = await page.locator('[data-qa="live-frame-count"]').textContent();
    const detailAfterFail = await page.locator('[data-qa="detail-frame-updated"]').textContent();
    const detailCountAfterFail = await page.locator('[data-qa="detail-frame-count"]').textContent();
    if (liveAfterFail !== "ff-live-1" || liveCountAfterFail !== "1") {
      throw new Error(`failed live frame must not commit (last-good), got ${liveAfterFail} count=${liveCountAfterFail}`);
    }
    if (detailAfterFail !== "ff-detail-1" || detailCountAfterFail !== "1") {
      throw new Error(`failed detail frame must not commit (last-good), got ${detailAfterFail} count=${detailCountAfterFail}`);
    }
    // embed 3 = 성공 frame — 실패 frame 이 seq 를 소유하지 않았음을 복구로 증명
    await forceResume();
    await page.waitForFunction(() =>
      document.querySelector('[data-qa="live-frame-count"]')?.textContent === "2"
      && document.querySelector('[data-qa="detail-frame-count"]')?.textContent === "2",
      null, { timeout: 8000 });
    const liveRecovered = await page.locator('[data-qa="live-frame-updated"]').textContent();
    const detailRecovered = await page.locator('[data-qa="detail-frame-updated"]').textContent();
    if (liveRecovered !== "ff-live-3") {
      throw new Error(`success live frame after failure must recover, got ${liveRecovered}`);
    }
    if (detailRecovered !== "ff-detail-3") {
      throw new Error(`success detail frame after failure must recover, got ${detailRecovered}`);
    }
    await page.close();
  }

  console.log("live multiplex frames UI: 3 passed, 0 failed");
} finally {
  await browser.close();
}
