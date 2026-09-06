/** QA owner/CI: non-interference, privacy, bounds and actual collector route. */
import assert from "node:assert/strict";
// @ts-expect-error -- test-only dependency without bundled declarations.
import { JSDOM } from "jsdom";
import { createAuthSessionDiagnostics } from "../../src/lib/auth/session-diagnostics";
import { authErrorMetadata, parseAuthDiagnostic } from "../../src/lib/auth/session-diagnostic-schema";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type Beacon = { body: Record<string, unknown>; init: RequestInit };

async function main() {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://app-fixture.invalid/" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  document.cookie = "sb-auth-fixture-auth-token=private_cookie_fixture; Path=/";
  document.cookie = "_ga=private_ga_fixture; Path=/";
  localStorage.setItem("kbo-auth-uid", "private_account_fixture");
  const originalCookies = document.cookie;
  const originalMarker = localStorage.getItem("kbo-auth-uid");
  const beacons: Beacon[] = [];
  const inserts: Record<string, unknown>[] = [];
  let authRequests = 0;
  let collectorFails = false;
  let rejected: unknown = null;
  let response = new Response("private_response_body_fixture", { status: 503 });
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, dom.window.location.href);
    if (url.pathname === "/api/telemetry/client-error") {
      beacons.push({ body: JSON.parse(String(init?.body)), init: init ?? {} });
      if (collectorFails) throw new Error("collector unavailable");
      return new Response('{"ok":true}', { status: 200 });
    }
    if (url.pathname === "/auth/v1/token") {
      authRequests++;
      if (rejected) throw rejected;
      return response;
    }
    if (url.pathname === "/rest/v1/admin_client_errors") {
      const body = JSON.parse(String(init?.body));
      inserts.push(...(Array.isArray(body) ? body : [body]));
      return new Response(null, { status: 201 });
    }
    return new Response("unrelated");
  };
  globalThis.fetch = transport;
  const observers: ReturnType<typeof createAuthSessionDiagnostics>[] = [];
  const make = () => {
    const observer = createAuthSessionDiagnostics();
    observers.push(observer);
    return { observer, fetcher: observer.observeFetch("https://auth-fixture.invalid", transport) };
  };
  const tokenUrl = "https://auth-fixture.invalid/auth/v1/token?grant_type=refresh_token";

  try {
    const { observer, fetcher } = make();
    const before = observer.capture();
    const returned = await fetcher(tokenUrl, { method: "POST", body: "private_request_body_fixture", headers: { authorization: "private_header_fixture" } });
    assert.equal(returned, response, "returns the original Response object");
    assert.equal(await returned.text(), "private_response_body_fixture", "response body remains unread by observer");
    await pause(30);
    assert.equal(authRequests, 1, "observer never issues another auth request");
    assert.equal(beacons.length, 1);
    assert.equal(beacons[0].init.credentials, "omit", "diagnostic transport sends no auth cookies");
    assert.deepEqual(Object.keys(beacons[0].init.headers!), ["content-type"]);
    const serialized = JSON.stringify(beacons[0].body);
    for (const secret of ["private_cookie_fixture", "private_ga_fixture", "private_account_fixture", "private_response_body_fixture", "private_request_body_fixture", "private_header_fixture"]) assert.ok(!serialized.includes(secret), "private values excluded");
    assert.equal(document.cookie, originalCookies);
    assert.equal(localStorage.getItem("kbo-auth-uid"), originalMarker);
    assert.ok(parseAuthDiagnostic(JSON.parse(String(beacons[0].body.message))));
    console.log("PASS response identity/body, no extra auth calls, and private data exclusion");

    for (let i = 0; i < 6; i++) await fetcher(tokenUrl);
    await pause(30);
    assert.equal(beacons.length, 1, "same retry status is deduplicated");
    observer.sessionRead(before, false, { name: "AuthRetryableFetchError", status: 503, code: "private_code_fixture", message: "private_message_fixture" });
    observer.sessionRead(before, true, null);
    document.cookie = "sb-auth-fixture-auth-token=; Max-Age=0; Path=/";
    observer.sessionRead(before, false, null);
    observer.sessionRead(before, false, { name: "AuthApiError", status: 400, code: "refresh_token_already_used" });
    await pause(30);
    assert.equal(beacons.length, 4, "at most four distinct observations per page");
    const diagnostics = beacons.map(x => JSON.parse(String(x.body.message)));
    assert.ok(diagnostics.some(x => x.event === "recovered"));
    assert.equal(diagnostics.find(x => x.event === "recovered").status, 503, "recovery carries last failure category if offline beacons were lost");
    assert.ok(diagnostics.some(x => x.event === "storage-disappeared" && x.before.auth === 1 && x.after.auth === 0));
    assert.ok(!JSON.stringify(diagnostics).includes("private_code_fixture"));
    console.log("PASS retry dedupe, recovery/storage observations and page budget");

    const intentional = make();
    intentional.observer.intentionalLogout();
    const countBeforeLogout = beacons.length;
    await intentional.fetcher(tokenUrl);
    intentional.observer.sessionRead(before, false, null);
    await pause(30);
    assert.equal(beacons.length, countBeforeLogout, "marked explicit logout suppressed");
    const hostile = Object.create(null);
    Object.defineProperty(hostile, "name", { get() { throw new Error("hostile getter"); } });
    assert.equal(authErrorMetadata(hostile).error, "OtherError");
    const failing = make();
    collectorFails = true;
    rejected = hostile;
    await assert.rejects(failing.fetcher(tokenUrl), error => error === hostile, "original rejection preserved even if metadata getter throws");
    await pause(30);
    rejected = null;
    response = new Response("success", { status: 200 });
    assert.equal(await failing.fetcher(tokenUrl), response);
    collectorFails = false;
    console.log("PASS explicit logout suppression and failing collector/error non-interference");

    const cookieDescriptor = Object.getOwnPropertyDescriptor(document, "cookie");
    const local = globalThis.localStorage;
    Object.defineProperty(document, "cookie", { configurable: true, get() { throw new Error("cookie denied"); } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem() { throw new Error("storage denied"); } } });
    assert.deepEqual(make().observer.capture(), { auth: null, otherAuth: null, ga: null, marker: null });
    if (cookieDescriptor) Object.defineProperty(document, "cookie", cookieDescriptor);
    else delete (document as unknown as Record<string, unknown>).cookie;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
    const valid = diagnostics[0];
    assert.equal(parseAuthDiagnostic({ ...valid, access_token: "private_extra_fixture" }), null);
    assert.equal(parseAuthDiagnostic({ ...valid, initial: { ...valid.initial, value: "private_nested_fixture" } }), null);
    assert.equal(parseAuthDiagnostic({ ...valid, os: { toString: null } }), null);
    assert.equal(parseAuthDiagnostic({ ...valid, code: "private_code_fixture" }), null);
    assert.equal(parseAuthDiagnostic({ ...valid, boot: "private_identifier_fixture" }), null);
    console.log("PASS inaccessible storage is unknown, and non-allowlisted payloads rejected");

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://auth-fixture.invalid";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-role-not-real";
    const { POST } = await import("../../src/app/api/telemetry/client-error/route");
    const { NextRequest } = await import("next/server");
    const post = (body: unknown) => POST(new NextRequest("https://app-fixture.invalid/api/telemetry/client-error", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const accepted = await post({ source: "auth-session", message: JSON.stringify(valid), platform: "ios_native", appVersion: "1.0.14 (26)", path: "/auth#private_fragment_fixture", stack: "private_stack_fixture", visitorId: "private_identifier_fixture", userAgent: "private_agent_fixture", digest: "private_digest_fixture" });
    assert.equal(accepted.status, 200);
    assert.equal(inserts.length, 1);
    for (const key of ["path", "stack", "visitor_id", "user_agent"]) assert.equal(inserts[0][key], null, `${key} stripped server-side`);
    assert.equal(inserts[0].digest, "auth-session-v1");
    await post({ source: "auth-session", message: JSON.stringify({ ...valid, access_token: "private_extra_fixture" }) });
    assert.equal(inserts.length, 1, "invalid observation is not inserted");
    await post({ source: "window-error", message: "legacy fixture", path: "/fixture", visitorId: "fixture-visitor" });
    assert.equal(inserts.length, 2);
    assert.equal(inserts[1].path, "/fixture", "legacy collector unchanged");
    assert.equal(inserts[1].visitor_id, "fixture-visitor");
    console.log("PASS actual collector strips identity/URL fields and preserves legacy reports");

    const cancelled = make();
    cancelled.observer.beginSessionRead();
    cancelled.observer.cancelPendingReads();
    const pending = make();
    const diagnosticCount = beacons.length;
    const authCount = authRequests;
    pending.observer.beginSessionRead();
    await pause(10_100);
    assert.equal(beacons.length, diagnosticCount + 1, "one pending read observation; cancelled read stays silent");
    assert.equal(JSON.parse(String(beacons.at(-1)!.body.message)).event, "session-read-pending");
    assert.equal(authRequests, authCount);
    console.log("PASS pending-read observation and cleanup without extra auth calls");
  } finally {
    for (const observer of observers) observer.cancelPendingReads();
    dom.window.close();
  }
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error instanceof Error ? error.message : "auth diagnostic fixture failed");
  process.exit(1);
});
