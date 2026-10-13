/** Reviewer/CI: actual proxy + SDK, observer and ingestion route; synthetic HTTP
 * only. No live accounts. Mutation targets: proxy record/header, final publish
 * hook (also covered by auth-session-transient), ID parser, collector stripping. */
import assert from "node:assert/strict";
// @ts-expect-error -- test-only dependency without declarations.
import { JSDOM } from "jsdom";
import { NextRequest, type NextFetchEvent } from "next/server";
import { createAuthSessionDiagnostics } from "../../src/lib/auth/session-diagnostics";
import { AUTH_BOOT_SOURCE, AUTH_BOOT_SERVER_SOURCE, AUTH_BOOT_TIMING, parseAuthBootDiagnostic, readBootTraceId } from "../../src/lib/auth/boot-trace-schema";

const authUrl = "https://auth-fixture.invalid";
const prefix = "sb-auth-fixture-auth-token";
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (exp: number) => `${encoded({ alg: "HS256", typ: "JWT" })}.${encoded({ exp, sub: "fixture-private-user" })}.${encoded("fixture-signature")}`;
const session = (exp: number) => ({ access_token: jwt(exp), refresh_token: "fixture-private-refresh", expires_at: exp, expires_in: 3600, token_type: "bearer", user: { id: "fixture-private-user" } });
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function main() {
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: authUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-not-real", SUPABASE_SERVICE_ROLE_KEY: "fixture-service-not-real", VERCEL_ENV: "production" });
  const originalFetch = globalThis.fetch;
  const originalCrypto = globalThis.crypto;
  const originalPerformance = globalThis.performance;
  let sampleByte = 0;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {
    getRandomValues: (array: Uint8Array) => { array[0] = sampleByte; return array; },
    randomUUID: () => originalCrypto.randomUUID(), subtle: originalCrypto.subtle,
  } });
  let accepted = false;
  let collectorFails = false;
  let tokenCalls = 0;
  let userCalls = 0;
  const rows: Record<string, unknown>[] = [];
  const beacons: { body: Record<string, unknown>; init: RequestInit }[] = [];
  const tasks: Promise<unknown>[] = [];
  const event = { waitUntil: (task: Promise<unknown>) => tasks.push(task) } as NextFetchEvent;
  const drain = async () => { await Promise.all(tasks.splice(0)); await pause(25); };
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://keubo.fan");
    if (url.origin === authUrl && url.pathname === "/auth/v1/token") {
      tokenCalls++;
      return accepted ? Response.json(session(Math.floor(Date.now() / 1000) + 3600))
        : Response.json({ code: "refresh_token_already_used", message: "fixture-private-error" }, { status: 400, headers: { "x-supabase-api-version": "2024-01-01" } });
    }
    if (url.origin === authUrl && url.pathname === "/auth/v1/user") {
      userCalls++;
      return Response.json({ id: "fixture-private-user" });
    }
    if (url.origin === authUrl && url.pathname === "/rest/v1/admin_client_errors") {
      const headers = new Headers(init?.headers);
      assert.equal(headers.has("cookie"), false); assert.equal(headers.has("user-agent"), false);
      const body = JSON.parse(String(init?.body));
      rows.push(...(Array.isArray(body) ? body : [body]));
      if (collectorFails) throw new Error("fixture-private-collector-error");
      return new Response(null, { status: 201 });
    }
    if (url.origin === "https://keubo.fan" && url.pathname === "/api/telemetry/client-error") {
      beacons.push({ body: JSON.parse(String(init?.body)), init: init! });
      if (collectorFails) throw new Error("fixture-private-collector-error");
      return Response.json({ ok: true });
    }
    throw new Error("unexpected fixture request");
  };
  const { proxy } = await import("../../src/proxy");
  const request = (cookie = "", extra: Record<string, string> = {}) => new NextRequest("https://keubo.fan/private-path?private-query", {
    headers: { host: "keubo.fan", cookie, "sec-fetch-dest": "document", "user-agent": "iPhone fixture-private-agent", ...extra },
  });
  const idFrom = (response: Response) => response.headers.get("server-timing")?.match(/kbo-auth-boot;desc="([^"]+)"/)?.[1];
  const traces = () => rows.filter(row => row.source === AUTH_BOOT_SERVER_SOURCE);
  const observers: ReturnType<typeof createAuthSessionDiagnostics>[] = [];
  let dom: JSDOM | undefined;
  try {
    const empty = await proxy(request(), event); await drain();
    const trace = idFrom(empty)!;
    assert.ok(trace, "empty arrival must have a same-document trace header");
    assert.equal(tokenCalls, 0, "empty arrival makes no auth calls");
    assert.equal(empty.headers.get("set-cookie"), null, "no diagnostic cookie");
    assert.equal(empty.headers.get("cache-control"), "private, no-store");
    assert.equal(empty.headers.get("vercel-cdn-cache-control"), "no-store");
    const emptyRow = JSON.parse(String(traces()[0].message));
    assert.equal(emptyRow.boot, trace); assert.equal(emptyRow.incomingAuth, 0); assert.equal(emptyRow.remainingAuth, 0);
    const second = await proxy(request("", { "x-kbo-auth-boot": trace }), event); await drain();
    assert.notEqual(idFrom(second), trace, "each document gets a fresh server ID; incoming IDs ignored");

    // Error metadata describes getClaims' return value, not every storage action.
    // Exercise the real auth-js shape check and SSR cookie adapter, not a mocked
    // getClaims result or a hand-written diagnostic row. This synthetic contrast
    // does NOT establish what malformed (or missing) data a real user had.
    const active = session(Math.floor(Date.now() / 1000) + 3600);
    const valid = await proxy(request(`${prefix}=base64-${encoded(active)}`), event); await drain();
    const validRow = JSON.parse(String(traces().at(-1)!.message));
    assert.equal(validRow.boot, idFrom(valid));
    assert.deepEqual(
      [validRow.incomingAuth, validRow.deletedAuth, validRow.writtenAuth, validRow.remainingAuth, validRow.error, validRow.code, validRow.status],
      [1, 0, 0, 1, null, null, null],
      "valid unexpired session is retained without a cookie rewrite",
    );
    assert.equal(valid.headers.get("set-cookie"), null);
    assert.equal(tokenCalls, 0);
    assert.equal(userCalls, 1, "valid HS256 fixture reaches the user validation endpoint");

    for (const missing of ["access_token", "refresh_token", "expires_at"] as const) {
      const incomplete: Record<string, unknown> = { ...active };
      delete incomplete[missing];
      const beforeRows = traces().length;
      const beforeCalls = tokenCalls + userCalls;
      const response = await proxy(request(`${prefix}=base64-${encoded(incomplete)}`), event); await drain();
      assert.equal(response.status, 200);
      assert.equal(tokenCalls + userCalls, beforeCalls, `${missing}: invalid shape is removed before remote auth`);
      assert.equal(traces().length, beforeRows + 1, `${missing}: exactly one trace`);
      const cookie = response.cookies.get(prefix);
      assert.equal(cookie?.value, "", `${missing}: response clears the original cookie`);
      assert.equal(cookie?.maxAge, 0, `${missing}: deletion is an actual response cookie`);
      const row = JSON.parse(String(traces().at(-1)!.message));
      assert.equal(row.boot, idFrom(response), `${missing}: row joins this response`);
      assert.deepEqual(
        [row.incomingAuth, row.deletedAuth, row.writtenAuth, row.remainingAuth, row.error, row.code, row.status],
        [1, 1, 0, 0, null, null, null],
        `${missing}: local invalid-session removal can have no returned auth error`,
      );
    }

    // A stored JSON null is a separate boundary: auth-js reads no session and
    // does not remove a non-null invalid shape. Cookie count is NOT validity.
    const nullSession = await proxy(request(`${prefix}=base64-${encoded(null)}`), event); await drain();
    const nullRow = JSON.parse(String(traces().at(-1)!.message));
    assert.equal(nullRow.boot, idFrom(nullSession));
    assert.equal(nullSession.headers.get("set-cookie"), null);
    assert.deepEqual(
      [nullRow.incomingAuth, nullRow.deletedAuth, nullRow.writtenAuth, nullRow.remainingAuth, nullRow.error, nullRow.code, nullRow.status],
      [1, 0, 0, 1, null, null, null],
      "cookie present with JSON null is not equivalent to a valid session or an invalid object",
    );
    assert.equal(tokenCalls, 0); assert.equal(userCalls, 1);
    console.log("PASS actual proxy/SDK: valid session retained; three missing-field shapes cleared with null error; JSON-null boundary retained");

    const expired = `${prefix}=base64-${encoded(session(1))}`;
    const rejected = await proxy(request(expired), event); await drain();
    assert.equal(rejected.cookies.get(prefix)?.maxAge, 0);
    assert.equal(tokenCalls, 1);
    const rejectedRow = JSON.parse(String(traces().at(-1)!.message));
    assert.equal(rejectedRow.boot, idFrom(rejected));
    assert.equal(rejectedRow.code, "refresh_token_already_used");
    assert.equal(rejectedRow.incomingAuth, 1); assert.equal(rejectedRow.remainingAuth, 0); assert.equal(rejectedRow.deletedAuth, 1);
    sampleByte = 255;
    const unsampled = await proxy(request(expired), event); await drain();
    assert.equal(unsampled.headers.get("server-timing"), null);
    assert.equal(unsampled.headers.get("set-cookie"), rejected.headers.get("set-cookie"), "trace cannot alter auth cookie behavior");
    sampleByte = 0; accepted = true;
    const rotated = await proxy(request(expired), event); await drain();
    const rotation = JSON.parse(String(traces().at(-1)!.message));
    assert.equal(rotation.writtenAuth, 1); assert.equal(rotation.remainingAuth, 1);
    assert.ok(rotated.cookies.get(prefix)?.value);
    for (const extra of [{ rsc: "1" }, { "next-router-prefetch": "1" }, { "sec-fetch-dest": "empty" }, { "user-agent": "Android" }]) {
      const count = traces().length;
      const response = await proxy(request("", extra), event); await drain();
      assert.equal(idFrom(response), undefined); assert.equal(traces().length, count);
    }
    const countBeforeDisabled = traces().length;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    assert.equal(idFrom(await proxy(request(), event)), undefined);
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-not-real";
    process.env.VERCEL_ENV = "preview";
    assert.equal(idFrom(await proxy(request(), event)), undefined);
    process.env.VERCEL_ENV = "production";
    await drain(); assert.equal(traces().length, countBeforeDisabled);
    collectorFails = true;
    const persistenceFailure = await proxy(request(), event); await drain();
    assert.equal(persistenceFailure.status, 200); assert.equal(persistenceFailure.headers.get("set-cookie"), null);
    collectorFails = false;
    console.log("PASS actual proxy/SDK: empty, rejected and rotated arrivals, per-document ID, sampling and auth non-interference");

    dom = new JSDOM("<!doctype html><body></body>", { url: "https://keubo.fan/" });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
    let timing: unknown[] = [{ name: AUTH_BOOT_TIMING, description: trace }];
    const perf = { getEntriesByType: () => [{ serverTiming: timing }], now: () => originalPerformance.now() } as unknown as Performance;
    Object.defineProperty(globalThis, "performance", { configurable: true, value: perf });
    const make = () => { const o = createAuthSessionDiagnostics(); o.observeFetch(authUrl, globalThis.fetch); observers.push(o); return o; };
    const bootBeacons = () => beacons.filter(b => b.body.source === AUTH_BOOT_SOURCE);
    localStorage.setItem("kbo-auth-uid", "fixture-private-marker");
    const observer = make(); const observed = observer.beginBoot();
    observer.sessionRead(observer.capture(), false, null);
    observed.finish("published", false); await drain();
    const body = bootBeacons().at(-1)!.body;
    const value = JSON.parse(String(body.message));
    assert.equal(value.boot, emptyRow.boot, "server arrival and final client result join exactly");
    assert.equal(value.outcome, "published"); assert.equal(value.session, false); assert.equal(value.cookieSession, false);
    assert.equal(value.initial.marker, true); assert.equal(value.after.auth, 0);
    assert.ok(parseAuthBootDiagnostic(value));
    observed.finish("published", true); observer.beginBoot().finish("published", true); await drain();
    assert.equal(bootBeacons().length, 1, "one terminal result per document");
    timing = []; const unlinked = make(); unlinked.beginBoot().finish("published", false); await drain();
    assert.equal(bootBeacons().length, 1, "missing timing is unlinked, no guessed correlation");
    timing = [{ name: AUTH_BOOT_TIMING, description: "not-an-id" }]; assert.equal(readBootTraceId(perf), null);
    timing = [{ name: AUTH_BOOT_TIMING, description: trace }, { name: AUTH_BOOT_TIMING, description: trace }]; assert.equal(readBootTraceId(perf), null);
    timing = [{ name: AUTH_BOOT_TIMING, description: trace }];
    const pending = make(); const pendingBoot = pending.beginBoot();
    await pause(10_030); await drain();
    assert.equal(JSON.parse(String(bootBeacons().at(-1)!.body.message)).event, "boot-pending");
    pendingBoot.finish("superseded", true); await drain();
    assert.equal(bootBeacons().length, 3, "max two boot records: pending then terminal");
    const final = JSON.parse(String(bootBeacons().at(-1)!.body.message));
    assert.equal(final.outcome, "superseded"); assert.equal(final.session, true);
    const cancelled = make(); const cancelledBoot = cancelled.beginBoot(); cancelled.cancelPendingReads(); cancelledBoot.finish("published", false); await drain();
    assert.equal(bootBeacons().length, 3, "cancelled/unmounted reads cannot finalize");
    cancelled.beginBoot().finish("error", null, { name: "TypeError", code: "private-code", message: "private-message" }); await drain();
    assert.equal(JSON.parse(String(bootBeacons().at(-1)!.body.message)).code, "other");
    collectorFails = true; const failing = make(); failing.beginBoot().finish("retryable-error", null, { name: "AuthRetryableFetchError", status: 503 }); await drain(); collectorFails = false;
    console.log("PASS client linkage: absent/unreadable/unknown semantics, pending/terminal bounds, cancellation and failing transport");

    const { POST } = await import("../../src/app/api/telemetry/client-error/route");
    const ingest = (payload: unknown) => POST(new NextRequest("https://keubo.fan/api/telemetry/client-error", { method: "POST", body: JSON.stringify(payload) }));
    const hostile = { ...body, visitorId: "fixture-private-visitor", userAgent: "fixture-private-agent", path: "private-path", stack: "private-stack", digest: "private-digest", isChunkError: true };
    await ingest(hostile);
    const stored = rows.at(-1)!;
    assert.equal(stored.source, AUTH_BOOT_SOURCE); assert.equal(stored.digest, "auth-boot-v1");
    for (const key of ["path", "stack", "user_agent", "visitor_id"]) assert.equal(stored[key], null);
    const count = rows.length;
    await ingest({ ...body, message: JSON.stringify({ ...value, userId: "fixture-private-user" }) });
    await ingest({ ...body, source: AUTH_BOOT_SERVER_SOURCE });
    assert.equal(rows.length, count, "reject extra message fields and public writes to server source");
    for (const b of bootBeacons()) { assert.equal(b.init.credentials, "omit"); assert.deepEqual(Object.keys(b.init.headers!), ["content-type"]); }
    for (const row of traces()) for (const key of ["path", "stack", "user_agent", "visitor_id", "app_version", "platform"]) assert.equal(row[key], null);
    for (const secret of ["fixture-private-user", "fixture-private-refresh", "fixture-private-marker", "fixture-private-agent", "fixture-private-error", "fixture-private-visitor", "private-path", "private-query", "private-stack"]) {
      assert.ok(!JSON.stringify(rows).includes(secret), "no private fixture values in diagnostic storage");
    }
    console.log("PASS actual collector: exact schema, identity stripping, server-source isolation and bounded safe payloads");
  } finally {
    for (const observer of observers) observer.cancelPendingReads();
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
    Object.defineProperty(globalThis, "performance", { configurable: true, value: originalPerformance });
    dom?.window.close();
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
