import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET, POST } from "../../src/app/api/og-meta/route";

const calls = new Map<string, number>();
const realFetch = globalThis.fetch;

function count(host: string): number {
  return calls.get(host) ?? 0;
}

function request(urls: string[]): NextRequest {
  return new NextRequest("https://keubo.fan/api/og-meta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls }),
  });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  calls.set(url.hostname, count(url.hostname) + 1);

  if (url.hostname === "success.example") {
    return new Response(
      '<html><head><meta property="og:title" content="cached"><meta property="og:image" content="/image.jpg"></head></html>',
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  }
  if (url.hostname === "inflight.example") {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return new Response('<html><head><meta property="og:title" content="inflight"></head></html>', {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }
  if (url.hostname === "timeout.example") {
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  }
  return new Response("upstream unavailable", { status: 503 });
}) as typeof fetch;

async function main(): Promise<void> {
  try {
    const successUrl = "https://success.example/article";
    const first = await POST(request([successUrl, successUrl]));
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { items: Record<string, { image: string | null } | null> };
    assert.equal(firstBody.items[successUrl]?.image, "https://success.example/image.jpg");
    assert.equal(count("success.example"), 1, "batch must dedupe identical URLs");

    await POST(request([successUrl]));
    assert.equal(count("success.example"), 1, "successful result must be cached");

    const single = await GET(new NextRequest(`https://keubo.fan/api/og-meta?url=${encodeURIComponent(successUrl)}`));
    assert.equal(single.status, 200, "existing GET contract must stay available");
    assert.equal(count("success.example"), 1, "GET must share the success cache");

    const inflightUrl = "https://inflight.example/article";
    await Promise.all([
      POST(request([inflightUrl])),
      POST(request([inflightUrl])),
    ]);
    assert.equal(count("inflight.example"), 1, "concurrent requests must share one in-flight fetch");

    const failureUrl = "https://failure.example/article";
    await POST(request([failureUrl]));
    await POST(request([failureUrl]));
    assert.equal(count("failure.example"), 1, "failed result must use negative TTL cache");

    for (let index = 1; index <= 3; index++) {
      await POST(request([`https://circuit.example/${index}`]));
    }
    await POST(request(["https://circuit.example/4"]));
    assert.equal(count("circuit.example"), 3, "open circuit must skip the fourth upstream fetch");

    const timeoutStartedAt = Date.now();
    const timeout = await POST(request(["https://timeout.example/article"]));
    const timeoutElapsed = Date.now() - timeoutStartedAt;
    const timeoutBody = await timeout.json() as { items: Record<string, unknown> };
    assert.equal(timeoutBody.items["https://timeout.example/article"], null);
    assert(timeoutElapsed >= 4_500 && timeoutElapsed < 7_000, `timeout must be bounded near 5s (got ${timeoutElapsed}ms)`);

    const tooMany = await POST(request(
      Array.from({ length: 11 }, (_, index) => `https://limit.example/${index}`),
    ));
    assert.equal(tooMany.status, 400, "batch must reject more than 10 URLs");

    console.log("PASS og-meta stability: batch/in-flight dedupe, positive/negative TTL, circuit breaker, timeout, GET compatibility");
  } finally {
    globalThis.fetch = realFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
