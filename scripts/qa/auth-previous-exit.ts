/** Reviewer/CI: real observer + collector, synthetic browser storage only.
 * Mutation: omit prevExit from either beacon, remove SDK success hook, remove
 * logout recording, weaken nested allowlist, or restore 500-char truncation. */
import assert from "node:assert/strict";
// @ts-expect-error -- test-only dependency without bundled declarations.
import { JSDOM } from "jsdom";
import { createAuthSessionDiagnostics } from "../../src/lib/auth/session-diagnostics";
import { parseAuthDiagnostic } from "../../src/lib/auth/session-diagnostic-schema";
import { parseAuthBootDiagnostic } from "../../src/lib/auth/boot-trace-schema";
import { AUTH_EXIT_MAX_AGE_MINUTES, isPreviousAuthExit } from "../../src/lib/auth/previous-exit-schema";

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 30));
const key = "kbo-auth-prev-exit-v1:sb-auth-fixture-auth-token";
const trace = "7d1d4de3-3cb6-4a29-a73a-d73a7d547caf";

async function main() {
  const realNow = Date.now;
  Date.now = () => 1_788_787_200_000; // Stable minute boundaries; timers still run normally.
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://app-fixture.invalid/" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "iPhone fixture" } });
  const savedPerformance = globalThis.performance;
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { getEntriesByType: () => [{ serverTiming: [{ name: "kbo-auth-boot", description: trace }] }] } });
  const storage = dom.window.localStorage;
  const cookies = "sb-auth-fixture-auth-token=private-cookie-fixture; Path=/";
  document.cookie = cookies;
  storage.setItem("kbo-auth-uid", "private-user-fixture");
  const beacons: { source: string; message: string; init: RequestInit }[] = [];
  const inserted: Record<string, unknown>[] = [];
  let tokenStatus = 503;
  let response = new Response("private-response-fixture", { status: tokenStatus });
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app-fixture.invalid/");
    if (url.pathname === "/api/telemetry/client-error") {
      beacons.push({ ...JSON.parse(String(init?.body)), init });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/rest/v1/admin_client_errors") {
      const body = JSON.parse(String(init?.body));
      inserted.push(...(Array.isArray(body) ? body : [body]));
      return new Response(null, { status: 201 });
    }
    return response;
  };
  globalThis.fetch = transport;
  const observers: ReturnType<typeof createAuthSessionDiagnostics>[] = [];
  const make = () => {
    const observer = createAuthSessionDiagnostics();
    observers.push(observer);
    return { observer, fetcher: observer.observeFetch("https://auth-fixture.invalid", transport) };
  };
  const boot = (observer: ReturnType<typeof createAuthSessionDiagnostics>, present: boolean) => {
    const observation = observer.beginBoot();
    observer.sessionRead(observer.capture(), present, null);
    observation.finish("published", present);
  };
  const messages = (source: string) => beacons.filter(b => b.source === source).map(b => JSON.parse(b.message));

  try {
    const first = make();
    first.observer.sessionEstablished(true);
    await pause();
    const refreshed = JSON.parse(storage.getItem(key)!);
    assert.equal(refreshed.kind, "refresh");
    assert.equal(refreshed.lastRefresh, "ok");
    assert.equal(refreshed.at, Math.floor(Date.now() / 60_000));
    assert.equal(refreshed.lastRefreshAt, refreshed.at);
    assert.equal(refreshed.authChunks, 1);
    assert.equal(document.cookie, cookies.split(";", 1)[0], "recording cannot write auth cookies");
    assert.equal(storage.getItem("kbo-auth-uid"), "private-user-fixture");
    assert.ok(!storage.getItem(key)!.includes("private-"), "diagnostic key stores no cookie/account values");
    boot(first.observer, true);
    await pause();
    assert.deepEqual(messages("auth-boot").at(-1).prevExit, { state: "missing", record: null }, "same document's writes cannot replace its frozen previous snapshot");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    const hidden = storage.getItem(key)!;
    assert.equal(JSON.parse(hidden).kind, "hidden");
    window.dispatchEvent(new dom.window.Event("pagehide"));
    assert.equal(storage.getItem(key), hidden, "lifecycle writes are limited to one per minute");
    first.observer.cancelPendingReads();
    console.log("PASS SDK-success snapshot, minute precision, frozen predecessor and lifecycle bound");

    document.cookie = "sb-auth-fixture-auth-token=; Max-Age=0; Path=/";
    const second = make();
    boot(second.observer, false);
    await pause();
    const auth = messages("auth-session").find(x => x.event === "initial-no-session");
    const bootMessage = messages("auth-boot").at(-1);
    const previous = { state: "present", record: JSON.parse(hidden) };
    assert.deepEqual(auth.prevExit, previous, "initial-no-session must carry previous observation");
    assert.deepEqual(bootMessage.prevExit, previous, "sampled boot result must carry the SAME previous observation");
    assert.equal(bootMessage.boot, auth.boot);
    assert.equal(bootMessage.session, false);
    assert.ok(parseAuthDiagnostic(auth));
    assert.ok(parseAuthBootDiagnostic(bootMessage));
    const legacy = { ...auth }; delete legacy.prevExit;
    assert.ok(parseAuthDiagnostic(legacy), "older deployed beacons stay accepted");
    console.log("PASS cross-document history joins both real observer sources, without changing guest state");

    second.observer.intentionalLogout();
    const logout = JSON.parse(storage.getItem(key)!);
    assert.equal(logout.kind, "logout");
    second.observer.sessionEstablished(true); // late refresh must not overwrite explicit logout.
    await pause();
    assert.equal(JSON.parse(storage.getItem(key)!).kind, "logout");
    const third = make();
    boot(third.observer, false);
    await pause();
    assert.equal(messages("auth-boot").at(-1).prevExit.record.kind, "logout", "a new page can identify old explicit logout despite surviving marker");
    window.dispatchEvent(new dom.window.Event("pagehide"));
    assert.equal(JSON.parse(storage.getItem(key)!).kind, "logout", "guest lifecycle cannot overwrite logout intent");
    third.observer.cancelPendingReads();
    console.log("PASS intentional logout survives next page and late callbacks without hiding observations");

    // Corrupt/old/denied are not collapsed into missing, and cannot carry PII.
    const checks = [
      { raw: null, expected: "missing" },
      { raw: "not JSON", expected: "invalid" },
      { raw: JSON.stringify({ ...refreshed, uid: "private-forged-fixture" }), expected: "invalid" },
      { raw: JSON.stringify({ ...refreshed, at: Math.floor(Date.now() / 60_000) - AUTH_EXIT_MAX_AGE_MINUTES - 1, lastRefresh: "none", lastRefreshAt: null }), expected: "expired" },
      { raw: JSON.stringify({ ...refreshed, at: Math.floor(Date.now() / 60_000) + 6 }), expected: "invalid" },
    ];
    for (const { raw, expected } of checks) {
      if (raw === null) storage.removeItem(key); else storage.setItem(key, raw);
      const test = make(); boot(test.observer, false); await pause();
      assert.deepEqual(messages("auth-boot").at(-1).prevExit, { state: expected, record: null });
      test.observer.cancelPendingReads();
    }
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new TypeError("fixture access denied"); } });
    const denied = make(); boot(denied.observer, false); await pause();
    assert.deepEqual(messages("auth-boot").at(-1).prevExit, { state: "unreadable", record: null });
    assert.equal(await denied.fetcher("https://auth-fixture.invalid/auth/v1/token?grant_type=refresh_token"), response);
    denied.observer.sessionEstablished(true); await pause();
    denied.observer.cancelPendingReads();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    assert.equal(isPreviousAuthExit({ state: "missing", record: refreshed }), false);
    assert.equal(isPreviousAuthExit({ state: "present", record: { ...refreshed, at: 1.5 } }), false);
    assert.equal(isPreviousAuthExit({ state: "present", record: { ...refreshed, marker: "private-forged-fixture" } }), false);
    console.log("PASS missing/invalid/expired/unreadable stay distinct; auth survives denied storage");

    storage.removeItem(key);
    document.cookie = cookies;
    const failed = make();
    assert.equal(await failed.fetcher("https://auth-fixture.invalid/auth/v1/token?grant_type=refresh_token"), response);
    window.dispatchEvent(new dom.window.Event("pagehide"));
    assert.equal(JSON.parse(storage.getItem(key)!).lastRefresh, "fail");
    tokenStatus = 200; response = new Response("still-private-fixture", { status: tokenStatus });
    assert.equal(await failed.fetcher("https://auth-fixture.invalid/auth/v1/token?grant_type=refresh_token"), response);
    assert.equal(JSON.parse(storage.getItem(key)!).lastRefresh, "fail", "HTTP 200 alone must not claim SDK storage completion");
    failed.observer.sessionEstablished(true); await pause();
    assert.equal(JSON.parse(storage.getItem(key)!).lastRefresh, "ok");
    failed.observer.cancelPendingReads();
    console.log("PASS refresh failure persists until an SDK success observation, not just HTTP 200");

    const prototype = Object.getPrototypeOf(storage);
    const originalSet = prototype.setItem;
    prototype.setItem = function(name: string, value: string) {
      if (name === key) throw new dom.window.DOMException("fixture quota", "QuotaExceededError");
      return originalSet.call(this, name, value);
    };
    try {
      const quota = make();
      quota.observer.sessionEstablished(true); await pause();
      window.dispatchEvent(new dom.window.Event("pagehide"));
      assert.equal(await quota.fetcher("https://auth-fixture.invalid/auth/v1/token?grant_type=refresh_token"), response);
      quota.observer.intentionalLogout();
      quota.observer.cancelPendingReads();
    } finally { prototype.setItem = originalSet; }
    const stoppedValue = storage.getItem(key);
    window.dispatchEvent(new dom.window.Event("pagehide"));
    assert.equal(storage.getItem(key), stoppedValue, "all stopped observers remove lifecycle listeners");
    console.log("PASS quota failure does not affect auth, logout, or lifecycle cleanup");

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://auth-fixture.invalid";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-role-not-real";
    const { POST } = await import("../../src/app/api/telemetry/client-error/route");
    const { NextRequest } = await import("next/server");
    const post = (source: string, message: unknown) => POST(new NextRequest("https://app-fixture.invalid/api/telemetry/client-error", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source, message: typeof message === "string" ? message : JSON.stringify(message), path: "/private-fixture", visitorId: "private-fixture", stack: "private-fixture", userAgent: "private-fixture" }) }));
    const expanded = { ...auth, error: "NavigatorLockAcquireTimeoutError", code: "refresh_token_already_used", status: 400 };
    assert.ok(JSON.stringify(expanded).length > 500, "fixture actually exercises expanded collector bound");
    await post("auth-session", expanded); await post("auth-boot", bootMessage);
    assert.equal(inserted.length, 2, "actual collector stores both sources intact");
    for (const row of inserted) {
      assert.deepEqual(JSON.parse(String(row.message)).prevExit, previous);
      for (const field of ["path", "stack", "visitor_id", "user_agent"]) assert.equal(row[field], null);
    }
    await post("auth-session", { ...expanded, prevExit: { ...previous, record: { ...refreshed, token: "private-forged-fixture" } } });
    await post("auth-boot", { ...bootMessage, prevExit: { ...previous, record: { ...refreshed, uid: "private-forged-fixture" } } });
    await post("auth-session", JSON.stringify(expanded) + " ".repeat(1000));
    assert.equal(inserted.length, 2, "nested identity and oversized JSON must be rejected, never truncated");
    await post("window-error", "x".repeat(600));
    assert.equal(String(inserted[2].message).length, 500, "legacy source length unchanged");
    assert.ok(beacons.every(b => b.init.credentials === "omit"));
    assert.ok(!JSON.stringify(beacons).includes("private-cookie-fixture") && !JSON.stringify(beacons).includes("private-user-fixture"));
    console.log("PASS real collector expanded bound, old source behavior, nested privacy and no-cookie transport");
  } finally {
    for (const observer of observers) observer.cancelPendingReads();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "performance", { configurable: true, value: savedPerformance });
    dom.window.close();
    Date.now = realNow;
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error instanceof Error ? error.message : "previous exit fixture failed"); process.exit(1); });
