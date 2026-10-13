import assert from "node:assert/strict";
import { loadOGPreview } from "../../src/lib/community/og-preview-cache";

const realFetch = globalThis.fetch;
const realNow = Date.now;
let now = realNow();
let calls = 0;
let mode = "success";
Date.now = () => now;
globalThis.fetch = (async (_input, init) => {
  calls++;
  assert.ok(init?.signal, "requests must have a timeout signal");
  if (mode === "network") throw new Error("offline");
  if (mode === "http") return new Response("unavailable", { status: 503 });
  if (mode === "json") return new Response("not json");
  return Response.json({ title: mode === "empty" ? null : "Article", image: null,
    description: null, siteName: null, url: "https://example.com/article" });
}) as typeof fetch;

async function main() {
  try {
    const url = "https://example.com/shared";
    const first = loadOGPreview(url);
    assert.equal(first, loadOGPreview(url), "concurrent callers must share the same promise");
    await Promise.all([first, loadOGPreview(url)]);
    assert.equal(calls, 1);
    await loadOGPreview(url);
    assert.equal(calls, 1, "remount within TTL must reuse successful metadata");
    now += 300_001;
    await loadOGPreview(url);
    assert.equal(calls, 2, "expired success must refetch");
    for (const failure of ["http", "network", "json"]) {
      mode = failure;
      const retryUrl = `https://example.com/${failure}`;
      await assert.rejects(loadOGPreview(retryUrl));
      mode = "success";
      const before = calls;
      await loadOGPreview(retryUrl);
      assert.equal(calls, before + 1, "failed responses must not poison retry");
    }
    mode = "empty";
    await loadOGPreview("https://example.com/empty");
    mode = "success";
    const beforeEmptyRetry = calls;
    await loadOGPreview("https://example.com/empty");
    assert.equal(calls, beforeEmptyRetry + 1, "empty metadata must not stick");
    for (let i = 0; i < 201; i++) await loadOGPreview(`https://example.com/bounded/${i}`);
    const beforeEvicted = calls;
    await loadOGPreview(url);
    assert.equal(calls, beforeEvicted + 1, "cache must evict older entries at its bound");
    console.log("PASS: concurrent sharing, success TTL, HTTP/network/JSON retry, empty recovery, bounded eviction");
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
