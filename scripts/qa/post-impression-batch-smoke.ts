import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { NextRequest } from "next/server";
import { createImpressionBatch, parseImpressionBatch } from "../../src/lib/community/impression-batch";

async function main() {
  const batches: number[][] = [];
  const q = createImpressionBatch(ids => batches.push(ids));
  for (let id = 1; id <= 19; id++) q.enqueue(id);
  assert.equal(batches.length, 0);
  await delay(200);
  assert.deepEqual(batches, [Array.from({ length: 19 }, (_, i) => i + 1)]);
  for (let id = 1; id <= 20; id++) q.enqueue(id);
  assert.equal(batches.length, 2, "size bound flushes immediately");
  q.enqueue(21); q.flush(); q.flush();
  await delay(200);
  assert.deepEqual(batches[2], [21]);
  assert.equal(batches.length, 3, "lifecycle/timer overlap must not duplicate");
  for (const body of [null, {}, { postIds: [] }, { postIds: [1, -1] }, { postIds: ["1"] },
    { postIds: Array(21).fill(1) }, { postIds: [Number.MAX_SAFE_INTEGER + 1] }]) {
    assert.equal(parseImpressionBatch(body), null);
  }

  const dom = new JSDOM("", { url: "https://example.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    sessionStorage: dom.window.sessionStorage, localStorage: dom.window.localStorage });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  let accept = true;
  const beacons: Array<{ url: string; body: Blob }> = [];
  const fetches: Array<{ url: unknown; init?: RequestInit }> = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    sendBeacon(url: string, body: Blob) { beacons.push({ url, body }); return accept; },
  } });
  globalThis.fetch = (async (url, init) => { fetches.push({ url, init }); return new Response(); }) as typeof fetch;
  const tracker = await import("../../src/lib/community/view-tracker");
  for (let i = 1; i <= 5; i++) tracker.trackPostImpressionOncePerSession(i, "qa-user");
  tracker.trackPostImpressionOncePerSession(1, "qa-user");
  tracker.trackPostClick(1); tracker.trackPostClick(1);
  assert.equal(beacons.length, 2, "clicks stay immediate and are not deduped");
  window.dispatchEvent(new dom.window.Event("pagehide"));
  assert.equal(beacons.length, 3);
  assert.deepEqual(JSON.parse(await beacons[2].body.text()), { postIds: [1, 2, 3, 4, 5] });
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await delay(200);
  assert.equal(beacons.length, 3);
  accept = false;
  tracker.trackPostImpressionOncePerSession(1, "other-user");
  assert.equal(fetches.length, 1, "hidden enqueue flushes; rejected beacon falls back once");
  assert.equal(fetches[0].init?.keepalive, true);
  assert.equal(fetches[0].url, "/api/posts/views");
  assert.equal(JSON.parse(String(fetches[0].init?.body)).postIds[0], 1);
  // Route tests below must never reach a network, even if RPC mocking regresses.
  globalThis.fetch = (() => { throw new Error("unexpected network in QA"); }) as typeof fetch;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://batch-qa.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "qa-placeholder";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "qa-placeholder";
  const { getSupabaseAdmin } = await import("../../src/lib/supabase/admin");
  const client = getSupabaseAdmin();
  const calls: Array<{ p_post_id: number; p_kind: string }> = [];
  let active = 0; let peak = 0;
  client.rpc = (async (_name: string, args: { p_post_id: number; p_kind: string }) => {
    calls.push(args); active++; peak = Math.max(peak, active); await delay(1); active--;
    return { error: args.p_post_id === 108 ? { message: "test failure" } : null };
  }) as unknown as typeof client.rpc;
  const { POST } = await import("../../src/app/api/posts/views/route");
  const post = (body: string) => POST(new NextRequest("https://example.test/api/posts/views", {
    method: "POST", body, headers: { "x-forwarded-for": "192.0.2.1" },
  }));
  for (const body of ['{', '{"postIds":[101,-1]}', '{"postIds":[]}', JSON.stringify({ postIds: Array(21).fill(101) })]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post(" ".repeat(2049))).status, 413);
  assert.equal(calls.length, 0, "invalid batches do not partially write");
  const ids = Array.from({ length: 12 }, (_, i) => i + 101);
  const result = await post(JSON.stringify({ postIds: ids }));
  assert.equal((await result.json()).ok, false, "partial failure is not success");
  assert.deepEqual(calls.map(c => c.p_post_id), ids);
  assert.ok(calls.every(c => c.p_kind === "impression"));
  assert.ok(peak <= 4);
  await post(JSON.stringify({ postIds: ids }));
  assert.equal(calls.length, 12, "existing per-post cap retained; no retry after partial failure");
  dom.window.close();
  console.log("PASS: batching, bounds, exit flush, dedup, clicks, fallback, route validation/cap/partial failure");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
