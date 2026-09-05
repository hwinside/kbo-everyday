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

  const calls: string[] = [];
  let responseStatus = 200;
  let deferStickerLoadMore = false;
  let resolveStickerLoadMore: ((response: Response) => void) | undefined;
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
    calls.push(url);
    if (deferStickerLoadMore && url.includes("/v1/stickers/") && url.includes("offset=20")) {
      return new Promise<Response>((resolve) => {
        resolveStickerLoadMore = resolve;
      });
    }
    const isStickerTrending = url.includes("/v1/stickers/trending");
    return new Response(JSON.stringify({
      data: responseStatus === 200 ? (isStickerTrending ? stickerPage : []) : undefined,
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
  console.log("PASS giphy request budget render smoke");
}

void main();
