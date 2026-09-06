/** Reviewer/CI: real proxy + SSR/auth SDK, synthetic HTTP only. No live credentials. */
import assert from "node:assert/strict";
import { NextRequest, type NextFetchEvent } from "next/server";
import { createServerSessionDiagnostics } from "../../src/lib/auth/server-session-diagnostics";

const prefix = "sb-auth-fixture-auth-token";
const authUrl = "https://auth-fixture.invalid";
const encoded = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
const jwt = (exp: number) => `${encoded({ alg: "HS256", typ: "JWT" })}.${encoded({ exp, sub: "fixture-account-private", aud: "authenticated" })}.fixture-signature`;
const session = (exp: number) => ({ access_token: jwt(exp), refresh_token: "fixture-refresh-private", expires_at: exp, expires_in: 3600, token_type: "bearer", user: { id: "fixture-account-private" } });
const cookie = `base64-${encoded(session(1))}`;

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = authUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fixture-anon-not-real";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-not-real";
  process.env.VERCEL_ENV = "preview";
  const { proxy } = await import("../../src/proxy");
  const originalFetch = globalThis.fetch;
  let failureCode = "refresh_token_already_used";
  let accepted = false;
  let collectorMode: "ok" | "reject" | "hang" = "ok";
  let tokenCalls = 0;
  const rows: Record<string, unknown>[] = [];
  const tasks: Promise<unknown>[] = [];
  const event = { waitUntil: (task: Promise<unknown>) => { tasks.push(task); } } as NextFetchEvent;
  const drain = async () => { await Promise.all(tasks.splice(0)); };
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== authUrl) throw new Error("unexpected fixture origin");
    if (url.pathname === "/auth/v1/token") {
      tokenCalls++;
      return accepted
        ? Response.json(session(Math.floor(Date.now() / 1000) + 3600))
        : Response.json({ code: failureCode, message: "fixture-raw-error-private" }, { status: 400, headers: { "x-supabase-api-version": "2024-01-01" } });
    }
    if (url.pathname === "/auth/v1/user") return Response.json({ id: "fixture-account-private" });
    if (url.pathname === "/rest/v1/admin_client_errors") {
      assert.equal(init?.credentials, "omit");
      assert.equal(new Headers(init?.headers).has("cookie"), false);
      assert.equal(new Headers(init?.headers).has("user-agent"), false);
      rows.push(JSON.parse(String(init?.body)));
      if (collectorMode === "reject") throw new Error("fixture-storage-error-private");
      if (collectorMode === "hang") return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("fixture-timeout")), { once: true });
      });
      return new Response(null, { status: 201 });
    }
    throw new Error(`unexpected fixture endpoint: ${url.pathname}`);
  };
  const request = (cookies = `${prefix}=${cookie}; _ga=fixture-ga-private`, extra: Record<string, string> = {}) => new NextRequest("https://app-fixture.invalid/private-path?private-query", {
    headers: { cookie: cookies, "user-agent": "iPhone fixture-agent-private", "sec-fetch-dest": "document", ...extra },
  });
  try {
    const response = await proxy(request(), event);
    assert.equal(response.status, 200);
    assert.equal(response.cookies.get(prefix)?.maxAge, 0);
    await drain();
    assert.equal(tokenCalls, 1, "no additional refresh requests");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "auth-session-server");
    const diagnostic = JSON.parse(String(rows[0].message));
    assert.equal(diagnostic.event, "auth-cookie-cleared");
    assert.equal(diagnostic.code, "refresh_token_already_used");
    assert.equal(diagnostic.status, 400);
    assert.equal(diagnostic.os, "ios");
    assert.equal(diagnostic.incomingAuth, 1);
    for (const key of ["path", "stack", "user_agent", "visitor_id", "platform", "app_version"]) assert.equal(rows[0][key], null);
    for (const value of [prefix, cookie, "fixture-refresh-private", "fixture-account-private", "fixture-ga-private", "fixture-agent-private", "fixture-raw-error-private", "private-path", "private-query"]) assert.ok(!JSON.stringify(rows).includes(value), "private values must not reach storage");
    console.log("PASS real proxy/SDK rejection: final deletion + original error, no private values");

    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const withoutObserver = await proxy(request(), event);
    assert.equal(withoutObserver.headers.get("set-cookie"), response.headers.get("set-cookie"), "diagnostics never change the response cookies");
    await drain();
    assert.equal(rows.length, 1, "no anon fallback for writes");
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-not-real";
    failureCode = "refresh_token_not_found";
    await proxy(request(), event);
    await drain();
    assert.equal(JSON.parse(String(rows.at(-1)!.message)).code, "refresh_token_not_found");
    failureCode = "fixture-secret-code-private";
    collectorMode = "reject";
    const onFailure = await proxy(request(), event);
    await drain();
    assert.equal(onFailure.status, 200);
    assert.equal(JSON.parse(String(rows.at(-1)!.message)).code, "other");
    assert.ok(!JSON.stringify(rows).includes(failureCode));
    console.log("PASS missing key, unknown error allowlist and collector failure non-interference");

    const before = rows.length;
    const authBefore = tokenCalls;
    await proxy(request("_ga=fixture-ga-private"), event);
    await proxy(request(undefined, { rsc: "1" }), event);
    await drain();
    assert.equal(rows.length, before);
    assert.equal(tokenCalls, authBefore, "missing cookies/RSC must remain auth no-ops");
    collectorMode = "ok";
    accepted = true;
    const chunks = `${prefix}.0=${cookie.slice(0, 40)}; ${prefix}.1=${cookie.slice(40)}`;
    const rotated = await proxy(request(chunks), event);
    await drain();
    assert.ok(rotated.cookies.get(prefix)?.value, "successful rotation writes new base cookie");
    assert.equal(rotated.cookies.get(prefix + ".0")?.maxAge, 0, "old chunks really were cleared");
    assert.equal(rows.length, before, "rotation cleanup must not be diagnosed as session deletion");
    console.log("PASS absent cookie/RSC no-ops and real SDK multi-chunk rotation exclusion");

    const observer = createServerSessionDiagnostics(authUrl, [prefix, "sb-other-auth-token"], "Android");
    const missing = { name: "AuthSessionMissingError" };
    observer.record([{ name: "sb-other-auth-token", value: "", maxAge: 0 }], missing, event);
    assert.equal(tasks.length, 0, "different project deletion ignored");
    observer.record([{ name: prefix, value: "", maxAge: 0 }], missing, event);
    observer.record([{ name: prefix, value: "", maxAge: 0 }], missing, event);
    await drain();
    assert.equal(rows.length, before + 1, "one observation per request");
    assert.equal(JSON.parse(String(rows.at(-1)!.message)).os, "android");
    collectorMode = "hang";
    const stalled = createServerSessionDiagnostics(authUrl, [prefix], "unknown");
    stalled.record([{ name: prefix, value: "", maxAge: 0 }], null, event);
    await drain(); // must abort at 1.5s rather than hanging the CI/function lifetime
    collectorMode = "reject";
    const hostile = { waitUntil(task: Promise<unknown>) { tasks.push(task); throw new Error("fixture-scheduler-error"); } } as unknown as NextFetchEvent;
    createServerSessionDiagnostics(authUrl, [prefix], "").record([{ name: prefix, value: "", maxAge: 0 }], null, hostile);
    await drain();
    console.log("PASS request cap, project isolation and bounded stalled collector");
  } finally { globalThis.fetch = originalFetch; }
}
main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error("FAIL auth server diagnostics (fixture values suppressed)");
  if (error instanceof Error) console.error(error.stack?.split("\n").filter(line => /^\s+at /.test(line)).slice(0, 3).join("\n"));
  process.exit(1);
});
