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
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ data: responseStatus === 200 ? [] : undefined }), {
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
        <GifPicker onSelect={() => undefined} onClose={() => undefined} />
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

  const stickerInput = container.querySelector("input");
  assert.ok(stickerInput);
  await act(async () => {
    valueSetter.call(stickerInput, "응원");
    stickerInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 750));
  });
  assert.equal(calls.length, 5, "settled sticker search must issue one request");
  assert.match(calls[4], /\/v1\/stickers\/search/);

  await act(async () => stickerRoot.unmount());
  console.log("PASS giphy request budget render smoke");
}

void main();
