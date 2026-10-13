import assert from "node:assert/strict";
// @ts-expect-error -- jsdom is a test-only dependency without bundled declarations.
import { JSDOM } from "jsdom";
import { StrictMode, act } from "react";

async function main() {
  process.env.NEXT_PUBLIC_GIPHY_GIFS_API_KEY = "test-gifs-key";
  process.env.NEXT_PUBLIC_GIPHY_STICKERS_API_KEY = "test-stickers-key";

  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://keubo.fan/community",
  });
  let visibleViewportHeight = 844;
  const visualViewport = new dom.window.EventTarget();
  Object.defineProperty(visualViewport, "height", { get: () => visibleViewportHeight });
  Object.defineProperty(dom.window, "visualViewport", { value: visualViewport });

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    DOMException: dom.window.DOMException,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });

  const { createRoot } = await import("react-dom/client");

  const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
  Object.assign(window, { gtag: (_command: string, event: string, properties: Record<string, unknown>) => {
    events.push({ event, properties });
  } });
  const calls: string[] = [];
  let responseStatus = 200;
  let deferGifPopular = false;
  let catalogStatus = 200;
  let catalogIds: string[] = ["qaPopular", "qaSecond"];
  let catalogCalls = 0;
  let deferCatalog = false;
  let resolveCatalog: ((response: Response) => void) | undefined;
  let emptyIdsResponse = false;
  let resolveGifPopular: ((response: Response) => void) | undefined;
  let deferStickerLoadMore = false;
  let resolveStickerLoadMore: ((response: Response) => void) | undefined;
  const gifPage = [{
    id: "qaPopular",
    title: "QA opening GIF",
    images: { fixed_height: { url: "https://media.giphy.com/qa-trending.gif", width: "100", height: "100" } },
  }];
  const stickerPage = Array.from({ length: 20 }, (_, index) => ({
    id: `sticker-${index}`,
    title: `Sticker ${index}`,
    images: {
      fixed_width_small: { url: `https://media.giphy.com/${index}.gif`, width: "100", height: "100" },
      fixed_width_small_still: { url: `https://media.giphy.com/${index}.png`, width: "100", height: "100" },
      original_still: { url: `https://media.giphy.com/${index}.png`, width: "100", height: "100" },
      original: { url: `https://media.giphy.com/${index}.gif`, width: "100", height: "100" },
      fixed_width: { url: `https://media.giphy.com/${index}.gif`, width: "100", height: "100" },
    },
  }));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/game-chat/popular-gifs") {
      catalogCalls++;
      if (deferCatalog) return new Promise<Response>((resolve) => { resolveCatalog = resolve; });
      return new Response(JSON.stringify({ ids: catalogIds }), { status: catalogStatus });
    }
    calls.push(url);
    if (deferGifPopular && new URL(url).pathname === "/v1/gifs") {
      return new Promise<Response>((resolve) => { resolveGifPopular = resolve; });
    }
    if (deferStickerLoadMore && url.includes("/v1/stickers/") && url.includes("offset=20")) {
      return new Promise<Response>((resolve) => {
        resolveStickerLoadMore = resolve;
      });
    }
    const isStickerTrending = url.includes("/v1/stickers/trending");
    return new Response(JSON.stringify({
      data: responseStatus === 200 ? (url.includes("/v1/stickers/") ? (isStickerTrending ? stickerPage : []) : emptyIdsResponse && new URL(url).pathname === "/v1/gifs" ? [] : gifPage) : undefined,
      pagination: isStickerTrending ? { total_count: 40 } : undefined,
    }), {
      status: responseStatus,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const { default: GifPicker } = await import("../../src/components/community/GifPicker");
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <StrictMode>
        <GifPicker
          context="community_gif"
          onSelect={() => undefined}
          onClose={() => undefined}
        />
      </StrictMode>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  assert.equal(calls.length, 1, "StrictMode mount must issue one Trending request");
  assert.match(calls[0], /\/v1\/gifs\/trending/);

  const input = container.querySelector("input");
  assert.ok(input);
  const valueSetter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  )?.set;
  assert.ok(valueSetter);

  await act(async () => {
    valueSetter.call(input, "승");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 750));
  });
  assert.equal(calls.length, 1, "one-character query must not issue a request");

  await act(async () => {
    valueSetter.call(input, "승리");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 750));
  });
  assert.equal(calls.length, 2, "settled search must issue one request");
  assert.match(calls[1], /\/v1\/gifs\/search/);

  await act(async () => {
    valueSetter.call(input, "");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.equal(calls.length, 2, "clearing search must not reload Trending");

  responseStatus = 429;
  await act(async () => {
    valueSetter.call(input, "홈런");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 750));
  });
  assert.equal(calls.length, 3, "rate-limited search must issue its first request");

  responseStatus = 200;
  await act(async () => {
    valueSetter.call(input, "안타");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 750));
  });
  assert.equal(calls.length, 3, "cooldown must block requests after 429");

  await act(async () => root.unmount());

  const { default: StickerTool } = await import("../../src/components/editor/StickerTool");
  const stickerRoot = createRoot(container);
  await act(async () => {
    stickerRoot.render(
      <StrictMode>
        <StickerTool addSvg={async () => undefined} addImage={async () => undefined} />
      </StrictMode>,
    );
  });

  const giphyTab = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "GIPHY",
  );
  assert.ok(giphyTab);
  await act(async () => giphyTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.equal(calls.length, 4, "StrictMode sticker panel must issue one Trending request");
  assert.match(calls[3], /\/v1\/stickers\/trending/);

  const loadMore = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "더보기",
  );
  assert.ok(loadMore);
  deferStickerLoadMore = true;
  await act(async () => {
    loadMore.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    loadMore.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(calls.length, 5, "identical concurrent requests must share one network call");
  assert.match(calls[4], /\/v1\/stickers\/trending.*offset=20/);
  assert.ok(resolveStickerLoadMore);
  await act(async () => {
    resolveStickerLoadMore?.(new Response(JSON.stringify({
      data: [],
      pagination: { total_count: 40 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await Promise.resolve();
  });
  deferStickerLoadMore = false;

  const stickerInput = container.querySelector("input");
  assert.ok(stickerInput);
  await act(async () => {
    valueSetter.call(stickerInput, "응원");
    stickerInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 750));
  });
  assert.equal(calls.length, 6, "settled sticker search must issue one request");
  assert.match(calls[5], /\/v1\/stickers\/search/);

  await act(async () => stickerRoot.unmount());

  // Actual game-chat picker: own IDs + one batch lookup, no Trending/typeahead calls.
  for (const platform of ["ios", "android"] as const) {
    process.env[`NEXT_PUBLIC_GIPHY_${platform.toUpperCase()}_GAME_CHAT_API_KEY`] = `fixture-${platform}-chat`;
    Object.assign(window, { Capacitor: { getPlatform: () => platform } });
    responseStatus = 200;
    deferGifPopular = true;
    let baseCalls: number = calls.length;
    const beforeCatalog = catalogCalls;
    const chatRoot = createRoot(container);
    await act(async () => chatRoot.render(<StrictMode><GifPicker context="game_chat_gif" onSelect={() => undefined} onClose={() => undefined} /></StrictMode>));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.equal(calls.length, ++baseCalls, "game-chat opening must resolve IDs exactly once in StrictMode");
    assert.equal(new URL(calls.at(-1)!).pathname, "/v1/gifs");
    assert.equal(new URL(calls.at(-1)!).searchParams.get("ids"), "qaPopular,qaSecond");
    assert.equal(new URL(calls.at(-1)!).searchParams.get("rating"), "g");
    assert.equal(catalogCalls, beforeCatalog + 1, "StrictMode loads the ID catalog once");
    assert.ok(container.textContent?.includes("크보팬 인기 GIF"));
    assert.ok(container.textContent?.includes("Powered by GIPHY"));
    const chatInput: HTMLInputElement | null = container.querySelector("input");
    assert.ok(chatInput);
    await act(async () => {
      valueSetter.call(chatInput, "승리");
      chatInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 750)); });
    assert.equal(calls.length, baseCalls, "game-chat typing does not auto-search");
    assert.ok(resolveGifPopular);
    await act(async () => {
      resolveGifPopular?.(new Response(JSON.stringify({ data: [{ ...gifPage[0], id: "qaSecond", title: "QA second GIF" }, ...gifPage] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }));
      await Promise.resolve();
    });
    deferGifPopular = false;
    assert.deepEqual(Array.from(container.querySelectorAll("img")).map((img) => img.alt), ["QA opening GIF", "QA second GIF"], "by-ID metadata follows local popularity order");
    assert.ok(container.querySelector('img[alt="QA opening GIF"]'), "opening GIFs render without another click, even while typing");
    const panel = container.firstElementChild as HTMLElement;
    const fullHeightCap = panel.style.maxHeight;
    await act(async () => {
      visibleViewportHeight = 400;
      visualViewport.dispatchEvent(new dom.window.Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.notEqual(panel.style.maxHeight, fullHeightCap, "keyboard visual-viewport change updates panel sizing");
    assert.equal(calls.length, baseCalls, "keyboard resize must not refetch GIPHY");
    assert.equal(catalogCalls, beforeCatalog + 1, "keyboard resize must not reload the popular ID catalog");
    assert.equal(chatInput.value, "승리", "keyboard resize preserves the draft search");
    assert.deepEqual(Array.from(container.querySelectorAll("img")).map((img) => img.alt), ["QA opening GIF", "QA second GIF"], "keyboard resize preserves the current GIF results");
    await act(async () => {
      visibleViewportHeight = 844;
      dom.window.dispatchEvent(new dom.window.Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.equal(panel.style.maxHeight, fullHeightCap, "window resize restores the panel size cap");
    assert.equal(calls.length, baseCalls, "orientation/window resize must not refetch GIPHY");
    const form = container.querySelector("form");
    assert.ok(form);
    await act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
    assert.equal(calls.length, ++baseCalls, "explicit game-chat Search issues one request");
    assert.equal(new URL(calls.at(-1)!).searchParams.get("q"), "승리");
    assert.equal(new URL(calls.at(-1)!).searchParams.get("api_key"), `fixture-${platform}-chat`);
    const result = events.findLast((entry) => entry.event === "giphy_api_result");
    assert.equal(result?.properties.giphy_platform, platform);
    assert.equal(result?.properties.key_slot, `${platform}:game_chat_gif`);
    assert.equal(result?.properties.key_source, "platform");
    assert.equal(result?.properties.status, 200);
    const popular = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "크보팬 인기 GIF");
    assert.ok(popular);
    responseStatus = 429;
    await act(async () => { popular.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.equal(calls.length, ++baseCalls, "explicit popular button issues one request");
    assert.ok(container.textContent?.includes("5분"));
    assert.ok(!container.textContent?.includes("검색 결과가 없어요"), "rate limit is not mislabeled as empty results");
    assert.equal(events.findLast((entry) => entry.event === "giphy_api_rate_limited")?.properties.giphy_platform, platform);
    await act(async () => { popular.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.equal(calls.length, baseCalls, "manual retry is blocked during cooldown");
    await act(async () => chatRoot.unmount());
    const reopened = createRoot(container);
    await act(async () => reopened.render(<GifPicker context="game_chat_gif" onSelect={() => undefined} onClose={() => undefined} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.equal(calls.length, baseCalls, "automatic ID lookup on reopen respects cooldown");
    assert.equal(catalogCalls, beforeCatalog + 2, "cooldown also avoids another catalog read");
    assert.ok(container.textContent?.includes("5분"), "reopening explains the active cooldown without a retry click");
    const retry = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "크보팬 인기 GIF");
    assert.ok(retry);
    await act(async () => { retry.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.equal(calls.length, baseCalls, "reopening cannot bypass cooldown");
    await act(async () => reopened.unmount());
  }
  // Cold start / DB failure / all removed IDs: automatic, labelled baseball
  // Search. A provider error/429 must not trigger a second provider call.
  const { resetGiphyCooldownsForTest } = await import("../../src/lib/community/giphy-request");
  for (const scenario of ["empty", "unavailable", "removed", "limited", "failure"] as const) {
    resetGiphyCooldownsForTest();
    localStorage.clear();
    responseStatus = scenario === "limited" ? 429 : scenario === "failure" ? 500 : 200;
    catalogStatus = scenario === "unavailable" ? 503 : 200;
    catalogIds = scenario === "empty" ? [] : ["qaPopular"];
    emptyIdsResponse = scenario === "removed";
    const before: number = calls.length;
    const fallbackRoot = createRoot(container);
    await act(async () => fallbackRoot.render(<StrictMode><GifPicker context="game_chat_gif" onSelect={() => undefined} onClose={() => undefined} /></StrictMode>));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    const added: URL[] = calls.slice(before).map((url) => new URL(url));
    assert.ok(added.every((url) => url.pathname !== "/v1/gifs/trending"), `${scenario}: Trending prohibited`);
    assert.equal(added.length, scenario === "removed" ? 2 : 1, `${scenario}: exact provider budget`);
    if (scenario === "limited" || scenario === "failure") {
      assert.equal(added[0].pathname, "/v1/gifs", `${scenario}: no search retry`);
      assert.ok(container.querySelector('[role="status"]'), `${scenario}: error is visible`);
    } else {
      assert.equal(added.at(-1)?.pathname, "/v1/gifs/search");
      assert.equal(added.at(-1)?.searchParams.get("q"), "야구");
      assert.ok(container.querySelector('img[alt="QA opening GIF"]'), `${scenario}: automatic fallback is visible`);
      assert.ok(container.textContent?.includes("야구 GIF"), "fallback is not passed off as local popularity");
    }
    await act(async () => fallbackRoot.unmount());
  }
  // Slow first-party catalog: deduplicate clicks, then ignore its stale result
  // if the user has already submitted a newer search.
  resetGiphyCooldownsForTest();
  localStorage.clear();
  responseStatus = 200;
  emptyIdsResponse = false;
  deferCatalog = true;
  const raceCalls: number = calls.length;
  const raceCatalogs: number = catalogCalls;
  const raceRoot = createRoot(container);
  await act(async () => raceRoot.render(<StrictMode><GifPicker context="game_chat_gif" onSelect={() => undefined} onClose={() => undefined} /></StrictMode>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  const popularButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "크보팬 인기 GIF");
  assert.ok(popularButton);
  await act(async () => { popularButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.equal(catalogCalls, raceCatalogs + 1, "pending catalog is single-flight");
  const raceInput = container.querySelector("input");
  assert.ok(raceInput);
  await act(async () => {
    valueSetter.call(raceInput, "승리");
    raceInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.equal(calls.length, raceCalls, "typing during catalog lookup does not call provider");
  const raceForm = container.querySelector("form");
  assert.ok(raceForm);
  await act(async () => { raceForm.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.equal(calls.length, raceCalls + 1, "new search can replace a pending catalog");
  assert.ok(resolveCatalog);
  await act(async () => {
    resolveCatalog?.(new Response(JSON.stringify({ ids: ["qaPopular"] }), { status: 200 }));
    await Promise.resolve();
  });
  assert.equal(calls.length, raceCalls + 1, "late catalog must not issue a stale batch request");
  assert.ok(container.textContent?.includes("검색 결과"), "late catalog cannot overwrite the search heading");
  await act(async () => raceRoot.unmount());
  assert.ok(events.some((entry) => entry.event === "giphy_api_result" && entry.properties.endpoint === "ids"));
  const recorded = JSON.stringify(events);
  assert.ok(!recorded.includes("fixture-") && !recorded.includes("test-gifs-key") && !recorded.includes("test-stickers-key"));
  assert.ok(!recorded.includes("승리") && !recorded.includes("api_key"));
  console.log("PASS giphy request budget render smoke + iOS/Android popular-IDs/fallback/explicit-search/cooldown/telemetry");
}

void main();
