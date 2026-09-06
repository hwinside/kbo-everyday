/**
 * Actual AuthProvider + installed Supabase auth-js lock + jsdom cookie storage.
 * Only HTTP is stubbed; no auth/getSession/subscriber mocks and no live accounts.
 * Run (QA owner): npx tsx scripts/qa/auth-callback-lock-render.tsx
 * Run this same script against the parent AuthContext too: the fallback case
 * must time out there. Nothing is fetched from the network or logged as tokens.
 */
import assert from "node:assert/strict";
// @ts-expect-error -- jsdom is a test-only dependency without bundled declarations.
import { JSDOM } from "jsdom";
import { act } from "react";

type FixtureUser = { id: string; aud: string; role: string; email: string; app_metadata: object; user_metadata: object; created_at: string };
const user = (id: string): FixtureUser => ({
  id, aud: "authenticated", role: "authenticated", email: `${id}@example.invalid`,
  app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z",
});
const jwt = (id: string, expired = false) => [
  { alg: "HS256", typ: "JWT" },
  { sub: id, exp: Math.floor(Date.now() / 1000) + (expired ? -60 : 3600) },
].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".") + ".eA";
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: auth lock did not release`)), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

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

  let activeUser = user("fixture-a");
  let mode: "fallback" | "hang" | "success" | "delayed" = "fallback";
  let releaseProfile: (() => void) | null = null;
  const profileCalls = new Map<string, number>();
  let refreshCalls = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, dom.window.location.href);
    if (url.hostname === "auth-fixture.invalid" && url.pathname === "/auth/v1/user") return json(activeUser);
    if (url.hostname === "auth-fixture.invalid" && url.pathname === "/auth/v1/token") {
      refreshCalls++;
      return json({ access_token: jwt(activeUser.id), refresh_token: "fixture-refresh-next", expires_in: 3600, token_type: "bearer", user: activeUser });
    }
    if (url.hostname === "auth-fixture.invalid" && url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    if (url.hostname === "app-fixture.invalid" && url.pathname === "/api/me/boot") {
      if (mode === "hang") return new Promise<Response>(() => {});
      return json({}, 503);
    }
    if (url.hostname === "auth-fixture.invalid" && url.pathname === "/rest/v1/profiles") {
      const id = url.searchParams.get("id")?.replace(/^eq\./, "") ?? "";
      const count = (profileCalls.get(id) ?? 0) + 1;
      profileCalls.set(id, count);
      if (mode === "fallback" && count === 1) return json({}, 503);
      if (mode === "delayed") await new Promise<void>(resolve => { releaseProfile = resolve; });
      return json([{ id, nickname: id, team_id: null, favorite_players: [] }]);
    }
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  }) as typeof fetch;

  const { supabase } = await import("../../src/lib/supabase/client");
  const { AuthProvider, useAuth } = await import("../../src/lib/supabase/AuthContext");
  const { createRoot } = await import("react-dom/client");
  await supabase.auth.initialize();
  // The fixture drives refresh explicitly. No timer/network outside these cases.
  await supabase.auth.stopAutoRefresh();
  function Probe() {
    const view = useAuth();
    return <output>{view.user?.id ?? "guest"}|{view.profile?.id ?? "none"}|{String(view.loading)}</output>;
  }
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  await act(async () => { root.render(<AuthProvider><Probe /></AuthProvider>); });
  await act(async () => { await pause(20); });
  const events: string[] = [];
  const { data: { subscription } } = supabase.auth.onAuthStateChange(event => { events.push(event); });
  const setSession = (expired: boolean) => supabase.auth.setSession({ access_token: jwt(activeUser.id, expired), refresh_token: "fixture-refresh" });

  // Expired session takes real _callRefreshToken -> TOKEN_REFRESHED while locked.
  // Both HTTP fallbacks fail, so actual supabase.from needs the same auth lock.
  await act(async () => {
    const result = await deadline(setSession(true), "TOKEN_REFRESHED/fallback");
    assert.equal(result.error, null);
    await pause(40);
  });
  assert.ok(events.includes("TOKEN_REFRESHED"));
  assert.equal(refreshCalls, 1);
  assert.equal(profileCalls.get(activeUser.id), 2, "raw REST failure then actual SDK fallback");
  assert.equal(container.textContent, `${activeUser.id}|${activeUser.id}|false`);
  await deadline(supabase.auth.getSession(), "post-refresh getSession");
  console.log("PASS actual TOKEN_REFRESHED lock releases; SDK fallback loads profile");

  await act(async () => { await deadline(supabase.auth.signOut({ scope: "local" }), "sign out A"); });
  activeUser = user("fixture-b");
  await act(async () => {
    const result = await deadline(setSession(false), "SIGNED_IN/fallback");
    assert.equal(result.error, null);
    await pause(40);
  });
  assert.ok(events.includes("SIGNED_IN"));
  assert.equal(container.textContent, `${activeUser.id}|${activeUser.id}|false`);
  assert.equal(profileCalls.get(activeUser.id), 2);
  console.log("PASS actual SIGNED_IN lock releases; SDK fallback loads profile");

  // An HTTP request that never settles must not hold auth refresh/sign-out.
  mode = "hang";
  activeUser = user("fixture-c");
  await act(async () => {
    await deadline(setSession(false), "hung profile does not hold sign in");
    await pause(20);
    await deadline(supabase.auth.refreshSession(), "hung profile does not hold refresh");
    await deadline(supabase.auth.signOut({ scope: "local" }), "hung profile does not hold logout");
  });
  assert.equal(container.textContent, "guest|none|false");
  console.log("PASS hanging profile I/O does not block refresh or sign-out");

  // Delayed A response arriving after B must not resurrect A's profile.
  mode = "delayed";
  activeUser = user("fixture-delayed");
  await act(async () => { await deadline(setSession(false), "delayed profile"); await pause(20); });
  assert.ok(releaseProfile, "old profile request is actually in flight");
  const releaseOld = releaseProfile as () => void;
  mode = "success";
  activeUser = user("fixture-new");
  await act(async () => {
    await deadline(setSession(false), "account switch");
    releaseOld();
    await pause(40);
  });
  assert.equal(container.textContent, `${activeUser.id}|${activeUser.id}|false`);
  console.log("PASS account switch fences delayed old profile response");

  await act(async () => { await deadline(supabase.auth.signOut({ scope: "local" }), "final logout"); root.unmount(); });
  subscription.unsubscribe();
  await supabase.auth.stopAutoRefresh();
  dom.window.close();
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error instanceof Error ? error.message : "auth callback fixture failed");
  process.exit(1);
});
