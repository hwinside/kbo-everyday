#!/usr/bin/env node
import playwright from "playwright";

const { chromium } = playwright;
const BASE_URL =
  process.argv.find((arg) => arg.startsWith("--base-url="))?.split("=")[1]
  ?? "http://localhost:3000";

function parseRelayRoute(route) {
  const url = new URL(route.request().url());
  return {
    url,
    path: url.pathname,
    gameId: url.searchParams.get("gameId"),
    include: (url.searchParams.get("include") ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  };
}

async function fulfillPoll(
  route,
  relay,
  {
    events = [],
    live = null,
    detail = null,
  } = {},
) {
  const { path, include } = parseRelayRoute(route);
  const isCombined = path === "/api/game-relay-events";
  if (!isCombined) {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(relay),
    });
    return;
  }

  const frames = [
    JSON.stringify({ channel: "relay", ok: true, status: 200, data: relay }),
  ];
  if (include.includes("events")) {
    frames.push(JSON.stringify({ channel: "events", ok: true, status: 200, data: { events } }));
  }
  if (include.includes("live") && live) {
    frames.push(JSON.stringify({ channel: "live", ok: true, status: 200, data: live }));
  }
  if (include.includes("detail") && detail) {
    frames.push(JSON.stringify({ channel: "detail", ok: true, status: 200, data: detail }));
  }
  frames.push("");

  await route.fulfill({
    contentType: "application/x-ndjson",
    body: frames.join("\n"),
  });
}

const browser = await chromium.launch();
try {
  let fetchCount = 0;
  let legacyEventsFetchCount = 0;
  const page = await browser.newPage();
  await page.route("**/api/game-events?*", async (route) => {
    legacyEventsFetchCount++;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: [] }) });
  });
  const requestUrls = [];
  await page.route(/\/api\/game-(?:relay|relay-events)\?/, async (route) => {
    fetchCount++;
    requestUrls.push(route.request().url());
    const { include } = parseRelayRoute(route);
    await fulfillPoll(
      route,
      { innings: [], updatedAt: `fetch-${fetchCount}` },
      {
        events: include.includes("events")
          ? (fetchCount === 1
              ? [{ id: "event-1", gameId: "qa-game-a", type: "game_start", timestamp: Date.now(), detail: {} }]
              : [])
          : [],
      },
    );
  });
  await page.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "networkidle" });
  if (fetchCount < 1) throw new Error("live initial fetch missing");
  if (legacyEventsFetchCount !== 0) {
    throw new Error(`legacy /api/game-events fetch must be removed, got ${legacyEventsFetchCount}`);
  }
  if (!requestUrls.some((url) => url.includes("/api/game-relay-events?") && url.includes("include=events"))) {
    throw new Error(`live initial fetch must use combined include=events route, got ${requestUrls.join(", ")}`);
  }
  await page.waitForTimeout(100);
  const initialFetchBaseline = fetchCount;
  const initialRelayUpdated = await page.locator('[data-qa="relay-updated"]').textContent();

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  });
  await page.waitForTimeout(3200);
  if (fetchCount !== initialFetchBaseline) {
    throw new Error(`hidden live state must suppress polling, got ${fetchCount - initialFetchBaseline} extra`);
  }
  await page.locator('[data-qa="finish-game"]').click();
  await page.waitForTimeout(50);
  if (fetchCount !== initialFetchBaseline) {
    throw new Error(`hidden final transition fetched unexpectedly: ${fetchCount - initialFetchBaseline} extra`);
  }

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction((prev) =>
    document.querySelector('[data-qa="relay-updated"]')?.textContent !== prev,
  initialRelayUpdated);
  if (fetchCount <= initialFetchBaseline) {
    throw new Error("visible final retry did not issue a follow-up fetch");
  }
  await page.close();

  let delayedFetchCount = 0;
  let releaseInitialFetch;
  const initialFetchGate = new Promise((resolve) => {
    releaseInitialFetch = resolve;
  });
  const delayedPage = await browser.newPage();
  await delayedPage.route(/\/api\/game-(?:relay|relay-events)\?/, async (route) => {
    delayedFetchCount++;
    if (delayedFetchCount === 1) await initialFetchGate;
    await fulfillPoll(route, { innings: [], updatedAt: `delayed-fetch-${delayedFetchCount}` });
  });
  await delayedPage.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "domcontentloaded" });
  await delayedPage.waitForFunction(() => document.querySelector('[data-qa="relay-status"]')?.textContent === "live");
  await delayedPage.locator('[data-qa="finish-game"]').evaluate((node) => node.click());
  await delayedPage.waitForFunction(() => document.querySelector('[data-qa="relay-status"]')?.textContent === "final");
  releaseInitialFetch();
  await delayedPage.waitForTimeout(500);
  if (delayedFetchCount < 2) {
    throw new Error(`in-flight live→final expected terminal retry, got ${delayedFetchCount} fetches`);
  }
  await delayedPage.close();

  {
    const switchPage = await browser.newPage();
    await switchPage.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      const urls = [];
      window.__qaSwitchUrls = () => urls.slice();
      window.fetch = (input, init = {}) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
        if (!url.includes("/api/game-relay")) return originalFetch(input, init);
        urls.push(url);
        const parsed = new URL(url, window.location.origin);
        const gameId = parsed.searchParams.get("gameId");
        const relay = {
          gameId,
          innings: [{ inning: 1, half: "top", teamName: "A", plays: [] }],
          updatedAt: `${gameId}-${urls.length}`,
        };
        const include = (parsed.searchParams.get("include") ?? "").split(",").filter(Boolean);
        if (include.length > 0) {
          const frames = [
            JSON.stringify({ channel: "relay", ok: true, status: 200, data: relay }),
          ];
          if (include.includes("events")) {
            frames.push(JSON.stringify({ channel: "events", ok: true, status: 200, data: { events: [] } }));
          }
          return Promise.resolve(new Response([...frames, ""].join("\n"), {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          }));
        }
        return Promise.resolve(new Response(JSON.stringify(relay), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      };
    });
    await switchPage.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "networkidle" });
    await switchPage.waitForTimeout(200);
    const reqUrls = await switchPage.evaluate(() => window.__qaSwitchUrls());
    const aReqCount = reqUrls.length;
    if (!reqUrls.some((u) => u.includes("gameId=qa-game-a"))) {
      throw new Error("initial A fetch missing");
    }
    if (reqUrls.some((u) => u.includes("gameId=qa-game-a") && u.includes("since="))) {
      throw new Error("first A fetch must be full (no since)");
    }
    await switchPage.locator('[data-qa="switch-game"]').evaluate((node) => node.click());
    await switchPage.waitForTimeout(200);
    const switchedUrls = await switchPage.evaluate(() => window.__qaSwitchUrls());
    const bUrls = switchedUrls.slice(aReqCount).filter((u) => u.includes("gameId=qa-game-b"));
    if (bUrls.length === 0) throw new Error("switch to B did not fetch B");
    if (bUrls[0].includes("since=")) {
      throw new Error("first B fetch leaked since from previous game cache");
    }
    await switchPage.close();

    const inflightPage = await browser.newPage();
    await inflightPage.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      const urls = [];
      let releaseA;
      const holdA = new Promise((resolve) => { releaseA = resolve; });
      window.__qaInflightUrls = () => urls.slice();
      window.__qaReleaseInflightA = () => releaseA();
      window.fetch = async (input, init = {}) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
        if (!url.includes("/api/game-relay")) return originalFetch(input, init);
        urls.push(url);
        const parsed = new URL(url, window.location.origin);
        const gameId = parsed.searchParams.get("gameId");
        if (gameId === "qa-game-a") await holdA;
        const relay = {
          gameId,
          innings: [{ inning: 1, half: "top", teamName: "A", plays: [] }],
          updatedAt: `${gameId}-live`,
        };
        const include = (parsed.searchParams.get("include") ?? "").split(",").filter(Boolean);
        if (include.length > 0) {
          const frames = [
            JSON.stringify({ channel: "relay", ok: true, status: 200, data: relay }),
          ];
          if (include.includes("events")) {
            frames.push(JSON.stringify({ channel: "events", ok: true, status: 200, data: { events: [] } }));
          }
          return new Response([...frames, ""].join("\n"), {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          });
        }
        return new Response(JSON.stringify(relay), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
    });
    await inflightPage.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "domcontentloaded" });
    await inflightPage.waitForFunction(() => document.querySelector('[data-qa="relay-status"]')?.textContent === "live");
    await inflightPage.locator('[data-qa="switch-game"]').evaluate((node) => node.click());
    await inflightPage.waitForTimeout(300);
    const inflightUrls = await inflightPage.evaluate(() => window.__qaInflightUrls());
    const bIssuedBeforeRelease = inflightUrls.some((u) => u.includes("gameId=qa-game-b"));
    if (!bIssuedBeforeRelease) {
      throw new Error("B fetch was blocked by A in-flight (did not start immediately)");
    }
    const bFirst = inflightUrls.find((u) => u.includes("gameId=qa-game-b"));
    if (bFirst?.includes("since=")) {
      throw new Error("immediate B fetch leaked since from previous game cache");
    }
    await inflightPage.evaluate(() => window.__qaReleaseInflightA());
    await inflightPage.waitForFunction(() =>
      document.querySelector('[data-qa="relay-game"]')?.textContent === "qa-game-b",
      null,
      { timeout: 1000 },
    );
    const shownGame = await inflightPage.locator('[data-qa="relay-game"]').textContent();
    if (shownGame !== "qa-game-b") {
      throw new Error(`stale A slow-body response overwrote B (shown: ${shownGame})`);
    }
    await inflightPage.close();
  }

  {
    const partialPage = await browser.newPage();
    await partialPage.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
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
          return Promise.resolve(new Response(JSON.stringify({
            gameId: "qa-game-a",
            innings: [],
            updatedAt: "relay-survived",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        }
        const frames = [
          JSON.stringify({
            channel: "relay",
            ok: true,
            status: 200,
            data: { gameId: "qa-game-a", innings: [], updatedAt: "relay-survived" },
          }),
        ];
        if (include.includes("events")) {
          frames.push(JSON.stringify({
            channel: "events",
            ok: false,
            status: 503,
            data: { error: "events unavailable" },
          }));
        }
        return Promise.resolve(new Response([...frames, ""].join("\n"), {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        }));
      };
    });
    await partialPage.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "networkidle" });
    await partialPage.waitForFunction(() =>
      document.querySelector('[data-qa="relay-updated"]')?.textContent !== "none"
    );
    const eventCount = await partialPage.locator('[data-qa="event-count"]').textContent();
    if (eventCount !== "0") throw new Error(`failed events frame leaked data: ${eventCount}`);
    await partialPage.close();
  }

  {
    const finalRetryPage = await browser.newPage();
    await finalRetryPage.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      let fetchCount = 0;
      window.__qaFinalFetchCount = () => fetchCount;
      window.fetch = (input, init = {}) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
        if (!url.includes("/api/game-relay")) return originalFetch(input, init);

        fetchCount++;
        const thisFetch = fetchCount;
        const parsed = new URL(url, window.location.origin);
        const include = (parsed.searchParams.get("include") ?? "").split(",").filter(Boolean);
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify({
              channel: "relay",
              ok: true,
              status: 200,
              data: {
                gameId: "qa-game-a",
                innings: [],
                updatedAt: `final-retry-${thisFetch}`,
              },
            })}\n`));
            if (!include.includes("events") || thisFetch !== 2) {
              if (include.includes("events")) {
                controller.enqueue(encoder.encode(`${JSON.stringify({
                  channel: "events",
                  ok: true,
                  status: 200,
                  data: { events: [] },
                })}\n`));
              }
              controller.close();
              return;
            }
            init.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          },
        });
        return Promise.resolve(new Response(stream, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        }));
      };
    });
    await finalRetryPage.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "networkidle" });
    const relayBeforeFinal = await finalRetryPage.locator('[data-qa="relay-updated"]').textContent();
    await finalRetryPage.locator('[data-qa="finish-game"]').evaluate((node) => node.click());
    await finalRetryPage.waitForFunction((prev) =>
      document.querySelector('[data-qa="relay-updated"]')?.textContent !== prev,
    relayBeforeFinal);
    await finalRetryPage.waitForFunction(() => window.__qaFinalFetchCount() >= 3, null, {
      timeout: 18_000,
    });
    const stableFinalFetchCount = await finalRetryPage.evaluate(() => window.__qaFinalFetchCount());
    await finalRetryPage.waitForTimeout(15_500);
    const finalFetchCount = await finalRetryPage.evaluate(() => window.__qaFinalFetchCount());
    if (finalFetchCount !== stableFinalFetchCount) {
      throw new Error(`successful final retry must stop polling, got ${stableFinalFetchCount} -> ${finalFetchCount}`);
    }
    await finalRetryPage.close();
  }

  {
    const slowRelayPage = await browser.newPage();
    await slowRelayPage.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      let fetchCount = 0;
      window.__qaSlowRelayFetchCount = () => fetchCount;
      window.fetch = (input, init = {}) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
        if (!url.includes("/api/game-relay")) return originalFetch(input, init);

        fetchCount++;
        const thisFetch = fetchCount;
        const parsed = new URL(url, window.location.origin);
        const include = (parsed.searchParams.get("include") ?? "").split(",").filter(Boolean);
        const encoder = new TextEncoder();
        let delayedRelay;
        const stream = new ReadableStream({
          start(controller) {
            const send = () => {
              controller.enqueue(encoder.encode(`${JSON.stringify({
                channel: "relay",
                ok: true,
                status: 200,
                data: {
                  gameId: "qa-game-a",
                  innings: [],
                  updatedAt: `slow-relay-${thisFetch}`,
                },
              })}\n`));
              if (include.includes("events")) {
                controller.enqueue(encoder.encode(`${JSON.stringify({
                  channel: "events",
                  ok: true,
                  status: 200,
                  data: { events: [] },
                })}\n`));
              }
              controller.close();
            };
            if (thisFetch === 2) delayedRelay = setTimeout(send, 13_000);
            else send();
            init.signal?.addEventListener("abort", () => {
              if (delayedRelay) clearTimeout(delayedRelay);
              controller.error(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          },
        });
        return Promise.resolve(new Response(stream, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        }));
      };
    });
    await slowRelayPage.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "networkidle" });
    const relayBeforeSlowFinal = await slowRelayPage.locator('[data-qa="relay-updated"]').textContent();
    await slowRelayPage.locator('[data-qa="finish-game"]').evaluate((node) => node.click());
    await slowRelayPage.waitForFunction((prev) =>
      document.querySelector('[data-qa="relay-updated"]')?.textContent !== prev,
    relayBeforeSlowFinal, { timeout: 16_000 });
    const stableSlowRelayFetchCount = await slowRelayPage.evaluate(() => window.__qaSlowRelayFetchCount());
    await slowRelayPage.waitForTimeout(2_500);
    const slowRelayFetchCount = await slowRelayPage.evaluate(() => window.__qaSlowRelayFetchCount());
    if (slowRelayFetchCount !== stableSlowRelayFetchCount) {
      throw new Error(`slow valid final relay must complete and stop polling, got ${stableSlowRelayFetchCount} -> ${slowRelayFetchCount}`);
    }
    await slowRelayPage.close();
  }

  console.log("game-relay hook UI: 17 passed, 0 failed");
} finally {
  await browser.close();
}
