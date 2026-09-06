/**
 * Actual AuthProvider + installed auth-js + jsdom cookies, HTTP fixture only.
 * QA owner runs: NODE_ENV=development npx tsx scripts/qa/auth-session-transient-render.tsx
 * No live accounts/network. The clock jump models an exhausted refresh retry
 * budget so a transient outage can be tested without 30 seconds of backoff.
 */
import assert from "node:assert/strict";
// @ts-expect-error -- jsdom is a test-only dependency without declarations.
import { JSDOM } from "jsdom";
import { act } from "react";

const uid = "fixture-transient";
const user = {
  id: uid, aud: "authenticated", role: "authenticated",
  email: "transient@example.invalid", app_metadata: {}, user_metadata: {},
  created_at: "2026-01-01T00:00:00Z",
};
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const jwt = () => [
  { alg: "HS256", typ: "JWT" },
  { sub: uid, exp: Math.floor(Date.now() / 1000) + 3600 },
].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".") + ".eA";
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://auth-fixture.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fixture-not-a-real-key";
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", {
    url: "https://app-fixture.invalid/", pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
    Event: dom.window.Event, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  let unavailable = false;
  let invalidRefresh = false;
  let failedRefreshes = 0;
  let successfulRefreshes = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, dom.window.location.href);
    if (url.hostname === "auth-fixture.invalid" && url.pathname === "/auth/v1/user") return json(user);
    if (url.hostname === "auth-fixture.invalid" && url.pathname === "/auth/v1/token") {
      if (unavailable) {
        failedRefreshes++;
        offset += 31_000;
        return json({ message: "Fixture temporary outage" }, 503);
      }
      if (invalidRefresh) return json({ code: "refresh_token_not_found", message: "Invalid Refresh Token: Refresh Token Not Found" }, 400);
      successfulRefreshes++;
      return json({ access_token: jwt(), refresh_token: "fixture-refresh-next", expires_in: 3600, token_type: "bearer", user });
    }
    if (url.hostname === "auth-fixture.invalid" && url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    if (url.hostname === "app-fixture.invalid" && url.pathname === "/api/me/boot") return json({}, 503);
    if (url.hostname === "auth-fixture.invalid" && url.pathname === "/rest/v1/profiles") {
      return json([{ id: uid, nickname: uid, team_id: null, favorite_players: [] }]);
    }
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  }) as typeof fetch;

  const { supabase } = await import("../../src/lib/supabase/client");
  const { AuthProvider, useAuth } = await import("../../src/lib/supabase/AuthContext");
  const { createRoot } = await import("react-dom/client");
  await supabase.auth.initialize();
  await supabase.auth.stopAutoRefresh();
  const seeded = await supabase.auth.setSession({ access_token: jwt(), refresh_token: "fixture-refresh-seed" });
  assert.equal(seeded.error, null);
  const events: string[] = [];
  const { data: { subscription } } = supabase.auth.onAuthStateChange(event => { events.push(event); });
  function Probe() {
    const view = useAuth();
    return <output>{view.user?.id ?? "guest"}|{view.profile?.id ?? "none"}|{String(view.loading)}</output>;
  }
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<AuthProvider><Probe /></AuthProvider>); await pause(30); });
    await act(async () => { await pause(30); });
    assert.equal(container.textContent, `${uid}|${uid}|false`, "baseline is authenticated");
    unavailable = true;
    offset += 3_601_000;
    await act(async () => {
      document.dispatchEvent(new dom.window.Event("visibilitychange"));
      await pause(80);
    });
    assert.ok(failedRefreshes > 0, "expired session really attempted refresh and received 503");
    assert.ok(document.cookie.includes("sb-"), "retryable failure must preserve the stored session");
    assert.ok(!events.includes("SIGNED_OUT"), "SDK did not emit a real logout");
    console.log("EVIDENCE refresh=503; stored-session=present; SIGNED_OUT=absent; view=" + container.textContent);
    assert.equal(container.textContent, `${uid}|${uid}|false`, "transient refresh failure must not publish a false logout");

    unavailable = false;
    await act(async () => {
      window.dispatchEvent(new dom.window.Event("online"));
      await pause(80);
    });
    assert.ok(successfulRefreshes > 0, "network recovery triggers a real refresh without reload or login");
    assert.equal(container.textContent, `${uid}|${uid}|false`);
    assert.ok(events.includes("TOKEN_REFRESHED"));
    console.log("PASS transient refresh preserves identity and online restores session");

    // Re-mount with an expired cookie during an outage: INITIAL_SESSION(null)
    // must not declare a confirmed guest when the SDK merely failed to refresh.
    await act(async () => { root.render(null); await pause(20); });
    unavailable = true;
    offset += 3_601_000;
    await act(async () => { root.render(<AuthProvider><Probe /></AuthProvider>); });
    await act(async () => { await pause(80); });
    assert.ok(document.cookie.includes("sb-"));
    assert.equal(container.textContent, "guest|none|true", "initial retryable failure leaves auth unresolved, not signed out");
    unavailable = false;
    await act(async () => { window.dispatchEvent(new dom.window.Event("online")); await pause(80); });
    assert.equal(container.textContent, `${uid}|${uid}|false`);
    console.log("PASS initial transient failure resolves on connectivity recovery");

    // A genuine server rejection still removes the session and publishes guest.
    invalidRefresh = true;
    offset += 3_601_000;
    await act(async () => { document.dispatchEvent(new dom.window.Event("visibilitychange")); await pause(80); });
    assert.ok(events.includes("SIGNED_OUT"));
    assert.ok(!document.cookie.includes("sb-"));
    assert.equal(container.textContent, "guest|none|false");
    const refreshCountAfterLogout = successfulRefreshes;
    await act(async () => { window.dispatchEvent(new dom.window.Event("online")); await pause(80); });
    assert.equal(successfulRefreshes, refreshCountAfterLogout, "connectivity recovery must not resurrect a rejected session");
    assert.equal(container.textContent, "guest|none|false");
    console.log("PASS definitive rejection and subsequent no-session remain signed out");
  } finally {
    await act(async () => { root.unmount(); });
    subscription.unsubscribe();
    await supabase.auth.stopAutoRefresh();
    dom.window.close();
    Date.now = realNow;
  }
}

main().then(() => process.exit(0)).catch(error => {
  Date.now = realNow;
  console.error(error instanceof Error ? error.message : "Fixture failed");
  process.exit(1);
});
