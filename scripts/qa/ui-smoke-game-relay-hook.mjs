#!/usr/bin/env node
import playwright from "playwright";

const { chromium } = playwright;
const BASE_URL =
  process.argv.find((arg) => arg.startsWith("--base-url="))?.split("=")[1]
  ?? "http://localhost:3000";

async function fulfillPoll(route, relay, events = []) {
  const isCombined = new URL(route.request().url()).pathname === "/api/game-relay-events";
  if (isCombined) {
    await route.fulfill({
      contentType: "application/x-ndjson",
      body: [
        JSON.stringify({ channel: "relay", ok: true, status: 200, data: relay }),
        JSON.stringify({ channel: "events", ok: true, status: 200, data: { events } }),
        "",
      ].join("\n"),
    });
    return;
  }
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(relay),
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
  await page.route(/\/api\/game-(?:relay|relay-events)\?/, async (route) => {
    fetchCount++;
    await fulfillPoll(
      route,
      { innings: [], updatedAt: `fetch-${fetchCount}` },
      fetchCount === 1 ? [{ id: "event-1", gameId: "qa-game-a", type: "game_start", timestamp: Date.now(), detail: {} }] : [],
    );
  });
  await page.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  if (fetchCount !== 1) throw new Error(`live initial fetch expected 1, got ${fetchCount}`);
  if (legacyEventsFetchCount !== 0) {
    throw new Error(`legacy /api/game-events fetch must be removed, got ${legacyEventsFetchCount}`);
  }
  await page.waitForFunction(() => document.querySelector('[data-qa="event-count"]')?.textContent === "1");

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
  await delayedPage.route(/\/api\/game-(?:relay|relay-events)\?/, async (route) => {
    delayedFetchCount++;
    if (delayedFetchCount === 1) await initialFetchGate;
    await fulfillPoll(route, { innings: [], updatedAt: `delayed-fetch-${delayedFetchCount}` });
  });
  await delayedPage.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "domcontentloaded" });
  await delayedPage.waitForFunction(() => document.querySelector('[data-qa="relay-status"]')?.textContent === "live");
  await delayedPage.waitForTimeout(2500);
  if (delayedFetchCount !== 1) {
    throw new Error(`expected first live fetch to start before final transition, got ${delayedFetchCount}`);
  }
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
    await switchPage.route(/\/api\/game-(?:relay|relay-events)\?/, async (route) => {
      const url = route.request().url();
      reqUrls.push(url);
      const gid = new URL(url).searchParams.get("gameId");
      await fulfillPoll(route, { gameId: gid, innings: [inning], updatedAt: `${gid}-${reqUrls.length}` });
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

    // in-flight 가드(삼순 blocker ② (a)(b)): A slow-body 를 지연시키고 그 사이 B로 전환.
    // 계약: (a) B full 이 A 완료를 기다리지 않고 즉시 시작(막힘 없음, since 없는 full),
    //       (b) 늦게 도착한 A slow-body 는 B 를 덮어쓰지 않는다.
    let releaseA;
    const aGate = new Promise((r) => { releaseA = r; });
    const inflightUrls = [];
    const inflightPage = await browser.newPage();
    await inflightPage.route(/\/api\/game-(?:relay|relay-events)\?/, async (route) => {
      const url = route.request().url();
      inflightUrls.push(url);
      const gid = new URL(url).searchParams.get("gameId");
      if (gid === "qa-game-a") await aGate; // A slow-body 보류
      try {
        await fulfillPoll(route, { gameId: gid, innings: [inning], updatedAt: `${gid}-live` });
      } catch {
        // A 는 전환 시 abort 되므로 fulfill 이 실패할 수 있다(정상).
      }
    });
    await inflightPage.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "domcontentloaded" });
    await inflightPage.waitForFunction(() => document.querySelector('[data-qa="relay-status"]')?.textContent === "live");
    await inflightPage.waitForTimeout(2500);
    if (!inflightUrls.some((u) => u.includes("gameId=qa-game-a"))) {
      throw new Error("expected first A fetch to start before switch-game");
    }
    // A 요청이 보류(slow-body)된 상태에서 B로 전환
    await inflightPage.locator('[data-qa="switch-game"]').click();
    // (a) A 가 아직 안 끝났는데 B 요청이 즉시 나가야 한다(막힘 없음).
    await inflightPage.waitForFunction(() =>
      Array.from(document.querySelectorAll("*")).length > 0, { timeout: 1000 }).catch(() => {});
    const bIssuedBeforeRelease = inflightUrls.some((u) => u.includes("gameId=qa-game-b"));
    if (!bIssuedBeforeRelease) {
      throw new Error("B fetch was blocked by A in-flight (did not start immediately)");
    }
    // B 첫 요청은 full(캐시 초기화로 since 없음)
    const bFirst = inflightUrls.find((u) => u.includes("gameId=qa-game-b"));
    if (bFirst.includes("since=")) {
      throw new Error("immediate B fetch leaked since from previous game cache");
    }
    await inflightPage.waitForFunction(() => document.querySelector('[data-qa="relay-game"]')?.textContent === "qa-game-b");
    // 이제 보류했던 A slow-body 릴리즈 → 늦게 도착해도(또는 abort 되어) B를 덮어쓰면 안 된다
    releaseA();
    await inflightPage.waitForTimeout(150);
    const shownGame = await inflightPage.locator('[data-qa="relay-game"]').textContent();
    if (shownGame !== "qa-game-b") {
      throw new Error(`stale A slow-body response overwrote B (shown: ${shownGame})`);
    }
    await inflightPage.close();
  }

  // events frame 실패가 같은 응답의 정상 relay frame을 지우거나 막으면 안 된다.
  {
    const partialPage = await browser.newPage();
    await partialPage.route("**/api/game-relay-events?*", async (route) => {
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [
          JSON.stringify({
            channel: "relay",
            ok: true,
            status: 200,
            data: { gameId: "qa-game-a", innings: [], updatedAt: "relay-survived" },
          }),
          JSON.stringify({
            channel: "events",
            ok: false,
            status: 503,
            data: { error: "events unavailable" },
          }),
          "",
        ].join("\n"),
      });
    });
    await partialPage.goto(`${BASE_URL}/qa/game-relay-hook`, { waitUntil: "networkidle" });
    await partialPage.waitForFunction(() =>
      document.querySelector('[data-qa="relay-updated"]')?.textContent === "relay-survived"
    );
    const eventCount = await partialPage.locator('[data-qa="event-count"]').textContent();
    if (eventCount !== "0") throw new Error(`failed events frame leaked data: ${eventCount}`);
    await partialPage.close();
  }

  // final events frame이 영구 pending이어도 12초 bound로 요청을 abort하고,
  // 다음 15초 retry가 실제 시작되며 성공 뒤 추가 polling이 멈춰야 한다.
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
            if (thisFetch !== 2) {
              controller.enqueue(encoder.encode(`${JSON.stringify({
                channel: "events",
                ok: true,
                status: 200,
                data: { events: [] },
              })}\n`));
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
    await finalRetryPage.waitForTimeout(2500);
    const initialFinalFetchCount = await finalRetryPage.evaluate(() => window.__qaFinalFetchCount());
    if (initialFinalFetchCount !== 1) {
      throw new Error(`expected first live fetch before final retry scenario, got ${initialFinalFetchCount}`);
    }
    await finalRetryPage.locator('[data-qa="finish-game"]').click();
    await finalRetryPage.waitForFunction(() =>
      document.querySelector('[data-qa="relay-updated"]')?.textContent === "final-retry-2"
    );
    await finalRetryPage.waitForFunction(() => window.__qaFinalFetchCount() === 3, null, {
      timeout: 18_000,
    });
    await finalRetryPage.waitForFunction(() =>
      document.querySelector('[data-qa="relay-updated"]')?.textContent === "final-retry-3"
    );
    await finalRetryPage.waitForTimeout(15_500);
    const finalFetchCount = await finalRetryPage.evaluate(() => window.__qaFinalFetchCount());
    if (finalFetchCount !== 3) {
      throw new Error(`successful final retry must stop polling, got ${finalFetchCount} requests`);
    }
    await finalRetryPage.close();
  }

  // relay 자체는 12초 events-tail bound보다 늦어도 서버 정상 상한 안이면 보존한다.
  // 이전 request-wide abort는 이 13초 relay를 폐기해 이 회귀가 timeout 난다.
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
              controller.enqueue(encoder.encode(`${JSON.stringify({
                channel: "events",
                ok: true,
                status: 200,
                data: { events: [] },
              })}\n`));
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
    await slowRelayPage.waitForTimeout(2500);
    const initialSlowRelayFetchCount = await slowRelayPage.evaluate(() => window.__qaSlowRelayFetchCount());
    if (initialSlowRelayFetchCount !== 1) {
      throw new Error(`expected first live fetch before slow-final scenario, got ${initialSlowRelayFetchCount}`);
    }
    await slowRelayPage.locator('[data-qa="finish-game"]').click();
    await slowRelayPage.waitForFunction(() =>
      document.querySelector('[data-qa="relay-updated"]')?.textContent === "slow-relay-2",
      null,
      { timeout: 16_000 },
    );
    await slowRelayPage.waitForTimeout(2_500);
    const slowRelayFetchCount = await slowRelayPage.evaluate(() => window.__qaSlowRelayFetchCount());
    if (slowRelayFetchCount !== 2) {
      throw new Error(`slow valid final relay must complete and stop polling, got ${slowRelayFetchCount} requests`);
    }
    await slowRelayPage.close();
  }

  console.log("game-relay hook UI: 17 passed, 0 failed");
} finally {
  await browser.close();
}
