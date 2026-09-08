/** Reviewer/CI. Real proxy + auth-js + SSR cookie adapter, synthetic HTTP only.
 * No live account/token/rate-limit traffic. Mutation: remove cookie veto,
 * remove either transport wiring, disable cooldown, or exclude 429/408. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { NextRequest, type NextFetchEvent } from "next/server";
import { createAuthRefreshGuard } from "../../src/lib/auth/refresh-guard";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";

const authUrl = "https://refresh-guard-fixture.invalid";
const prefix = "sb-refresh-guard-fixture-auth-token";
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const encoded = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const session = (expired: boolean) => {
  const exp = Math.floor(clock / 1000) + (expired ? -60 : 3600);
  return {
    access_token: [encoded({ alg: "HS256", typ: "JWT" }), encoded({ exp, sub: "guard-user" }), "eA"].join("."),
    refresh_token: "guard-refresh-fixture", expires_at: exp, expires_in: 3600,
    token_type: "bearer", user: { id: "guard-user" },
  };
};

async function main() {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: authUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-not-real",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-not-real", VERCEL_ENV: "production",
  });
  const originalFetch = globalThis.fetch;
  const originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {
    getRandomValues: (a: Uint8Array) => { a[0] = 0; return a; },
    randomUUID: () => originalCrypto.randomUUID(),
    subtle: originalCrypto.subtle,
  } });
  let status = 429;
  let tokenCalls = 0;
  const stored: Record<string, unknown>[] = [];
  const tasks: Promise<unknown>[] = [];
  const event = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as NextFetchEvent;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== authUrl) throw new Error("Unexpected fixture origin");
    if (url.pathname === "/auth/v1/token") {
      tokenCalls++;
      return status === 200 ? Response.json(session(false)) : Response.json({
        code: status === 429 ? "over_request_rate_limit" : status === 408 ? "request_timeout" : "refresh_token_already_used",
        message: "Synthetic auth response",
      }, { status, headers: { "retry-after": "120", "x-supabase-api-version": "2024-01-01" } });
    }
    if (url.pathname === "/auth/v1/user") return Response.json({ id: "guard-user" });
    if (url.pathname === "/rest/v1/admin_client_errors") {
      const body = JSON.parse(String(init?.body));
      stored.push(...(Array.isArray(body) ? body : [body]));
      return new Response(null, { status: 201 });
    }
    throw new Error("Unexpected fixture request");
  };
  const { proxy } = await import("../../src/proxy");
  function request() {
    const value = "base64-" + encoded(session(true));
    const middle = Math.floor(value.length / 2);
    return new NextRequest("https://keubo.fan/", { headers: {
      host: "keubo.fan", "sec-fetch-dest": "document", "user-agent": "iPhone synthetic QA",
      cookie: `${prefix}.0=${value.slice(0, middle)}; ${prefix}.1=${value.slice(middle)}`,
    } });
  }
  const trace = () => JSON.parse(String(stored.filter(r => r.source === "auth-boot-server").at(-1)!.message));
  async function runProxy() {
    const req = request();
    const before = req.headers.get("cookie");
    const response = await proxy(req, event);
    await Promise.all(tasks.splice(0));
    return { req, before, response, row: trace() };
  }
  try {
    for (const temporary of [429, 408]) {
      status = temporary; clock += 180_000;
      const callsBefore = tokenCalls;
      const first = await runProxy();
      assert.equal(tokenCalls, callsBefore + 1, "one upstream refresh, no SSR retry loop");
      assert.equal(first.req.headers.get("cookie"), first.before, "request cookies must not be deleted before render");
      assert.equal(first.response.headers.get("set-cookie"), null, "transient failure must not clear browser cookies");
      assert.deepEqual([first.row.incomingAuth, first.row.deletedAuth, first.row.writtenAuth, first.row.remainingAuth, first.row.status],
        [2, 0, 0, 2, temporary], "diagnostic keeps REAL status and reports cookie preservation");
      assert.equal(stored.filter(r => r.source === "auth-session-server").length, 0, "no false cookie-cleared event");
      // Another request/client in the same warm server instance respects Retry-After.
      clock += 119_000;
      const second = await runProxy();
      assert.equal(tokenCalls, callsBefore + 1, "cooldown must not contact upstream");
      assert.equal(second.response.headers.get("set-cookie"), null);
      assert.equal(second.row.status, temporary);
      assert.equal(second.row.code, "refresh_backoff", "local brake must not pretend another upstream error occurred");
      clock += 1_001; status = 200;
      const recovered = await runProxy();
      assert.equal(tokenCalls, callsBefore + 2, "one retry after Retry-After expires");
      assert.equal(recovered.row.status, null);
      assert.ok(recovered.response.cookies.get(prefix)?.value, "normal rotation writes a new session");
      assert.equal(recovered.row.remainingAuth, 1, "old chunks cleaned only on successful rotation");
    }
    status = 400; clock += 180_000;
    const rejected = await runProxy();
    assert.deepEqual([rejected.row.deletedAuth, rejected.row.remainingAuth, rejected.row.status, rejected.row.code],
      [2, 0, 400, "refresh_token_already_used"], "definitive rejection still removes session");
    assert.equal(rejected.response.cookies.get(prefix + ".0")?.maxAge, 0);
    assert.equal(stored.filter(r => r.source === "auth-session-server").length, 1);
    console.log("PASS real proxy: 429/408 preserve both cookie boundaries, cooldown, recovery, terminal rejection");

    // Browser boundary preserves HTTP diagnostics and never rewrites 429 to 503.
    let hits = 0;
    const original = Response.json({ code: "over_request_rate_limit" }, { status: 429, headers: { "retry-after": new Date(clock + 180_000).toUTCString() } });
    const guard = createAuthRefreshGuard("https://browser-guard.invalid", async () => { hits++; return original; }, "browser");
    const refreshUrl = "https://browser-guard.invalid/auth/v1/token?grant_type=refresh_token";
    await assert.rejects(guard.fetch(refreshUrl, { method: "POST" }), e => isAuthRetryableFetchError(e) && e.status === 429);
    assert.equal(original.status, 429);
    clock += 170_000;
    await assert.rejects(guard.fetch(refreshUrl, { method: "POST" }), isAuthRetryableFetchError);
    assert.equal(hits, 1, "SDK retries during cooldown cannot amplify upstream requests");
    // Neither other origins nor other grants/methods are normalized or blocked.
    assert.equal(await guard.fetch("https://browser-guard.invalid/auth/v1/token?grant_type=password", { method: "POST" }), original);
    assert.equal(await guard.fetch("https://foreign.invalid/auth/v1/token?grant_type=refresh_token", { method: "POST" }), original);
    assert.equal(await guard.fetch(refreshUrl, { method: "GET" }), original);
    await guard.fetch("https://browser-guard.invalid/auth/v1/logout", { method: "POST" });
    assert.equal(guard.preserveSessionCookies(), false, "explicit logout must remain allowed");
    console.log("PASS browser guard: retryable failure, Retry-After date, origin/grant/method scope, explicit logout");
    // Separate real AuthProvider documents keep the production four-event cap
    // intact. Exercise both 429 and 408 through the ACTUAL client.ts wiring.
    for (const temporary of [429, 408]) {
      const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/qa/auth-session-transient-render.tsx", String(temporary)], {
        encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_ENV: "development" },
      });
      if (run.status !== 0) process.stderr.write(run.stderr || run.stdout);
      assert.equal(run.status, 0, `actual AuthProvider ${temporary}: cookies, identity, cold boot, recovery and rejection`);
      process.stdout.write(run.stdout);
    }
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
    Date.now = realNow;
  }
}
main().then(() => process.exit(0)).catch(error => {
  Date.now = realNow;
  console.error(error instanceof Error ? error.message : "Refresh guard fixture failed");
  process.exit(1);
});
