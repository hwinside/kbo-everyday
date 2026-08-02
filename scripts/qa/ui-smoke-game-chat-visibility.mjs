#!/usr/bin/env node
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:3057";
const authActual = process.env.GAME_CHAT_VISIBILITY_AUTH_ACTUAL === "1";
const gamePath = "/games/20260328-LG-DS";
const browser = await chromium.launch({ headless: true });

function pass(message) {
  console.log(`  ✓ ${message}`);
}

async function guestSmoke() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${baseUrl}${gamePath}`, { waitUntil: "networkidle" });
  const hide = page.getByRole("button", { name: "전체 채팅 끄기" });
  await hide.waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-composer="game-chat"]').count(), 1, "ON이면 composer가 있어야 한다");

  await hide.click();
  await page.getByRole("button", { name: "전체 채팅 켜기" }).waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-composer="game-chat"]').count(), 0, "OFF면 composer DOM이 없어야 한다");
  assert.equal(await page.locator("text=전체 채팅").count(), 0, "OFF면 채팅 header도 없어야 한다");

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "전체 채팅 켜기" }).waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-composer="game-chat"]').count(), 0, "비로그인 OFF 설정은 reload 후 유지되어야 한다");

  await page.getByRole("button", { name: "전체 채팅 켜기" }).click();
  await page.getByRole("button", { name: "전체 채팅 끄기" }).waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-composer="game-chat"]').count(), 1, "ON 복귀 시 composer가 다시 생겨야 한다");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "390px 가로 overflow가 없어야 한다");
  pass("guest ON→OFF→reload→ON, 390px");
}

async function injectSession(context, session) {
  await context.addInitScript(
    ([accessToken, refreshToken]) => {
      sessionStorage.setItem("kbo-pending-session", JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
      }));
    },
    [session.access_token, session.refresh_token],
  );
}

async function authActualSmoke() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.ok(url && anon && serviceRole, "auth actual에는 격리 Supabase env가 필요하다");

  const admin = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
  const stamp = Date.now().toString(36);
  const users = [];
  let cleanupFailed = false;

  async function createQaUser(label) {
    const email = `qa-chat-visibility-${label}-${stamp}@keubo.fan`;
    const password = `QaChat!${label}${stamp}`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error("createUser failed");
    const user = created.data.user;
    users.push(user.id);
    const profile = await admin.from("profiles").insert({
      id: user.id,
      nickname: `qa-chat-${label}-${stamp.slice(-4)}`,
      team_id: 2002,
    });
    if (profile.error) throw profile.error;
    const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error || !signedIn.data.session) throw signedIn.error ?? new Error("signIn failed");
    return { id: user.id, session: signedIn.data.session };
  }

  async function apiPreference(page, token, method, visible) {
    return page.evaluate(async ({ token, method, visible }) => {
      const init = method === "PUT"
        ? { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ visible }) }
        : { method, headers: { Authorization: `Bearer ${token}` } };
      const response = await fetch("/api/game-chat/prefs", init);
      return { status: response.status, body: await response.json() };
    }, { token, method, visible });
  }

  try {
    const [owner, other] = await Promise.all([createQaUser("owner"), createQaUser("other")]);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await injectSession(context, owner.session);
    const page = await context.newPage();
    await page.goto(`${baseUrl}${gamePath}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "전체 채팅 끄기" }).waitFor({ state: "visible" });

    const initial = await apiPreference(page, owner.session.access_token, "GET");
    assert.deepEqual(initial, { status: 200, body: { visible: true } }, "계정 기본값 GET=true");
    pass("전용 계정 GET 기본값 ON");

    const textarea = page.locator('[data-composer="game-chat"] textarea[name="chat-message"]');
    await textarea.focus();
    await page.waitForFunction(() => document.body.classList.contains("kbd-open"));
    const beforeScroll = await page.evaluate(() => window.scrollY);
    await page.getByRole("button", { name: "전체 채팅 끄기" }).click();
    await page.getByRole("button", { name: "전체 채팅 켜기" }).waitFor({ state: "visible" });
    await page.waitForTimeout(150);
    assert.equal(await page.locator('[data-composer="game-chat"]').count(), 0, "OFF면 composer target 0");
    assert.equal(await page.evaluate(() => document.activeElement?.closest?.('[data-composer="game-chat"]') !== null), false, "OFF면 active chat focus target 0");
    assert.equal(await page.evaluate(() => document.body.classList.contains("kbd-open")), false, "OFF면 kbd-open 해제");
    assert.ok(Math.abs((await page.evaluate(() => window.scrollY)) - beforeScroll) <= 2, "OFF 전환이 자동 스크롤을 만들지 않아야 한다");
    pass("focus 상태 OFF → target 0, kbd-open=false, scroll 이동 0");

    const storedOff = await apiPreference(page, owner.session.access_token, "GET");
    assert.deepEqual(storedOff, { status: 200, body: { visible: false } }, "PUT OFF 뒤 GET=false");
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "전체 채팅 켜기" }).waitFor({ state: "visible" });
    assert.equal(await page.locator('[data-composer="game-chat"]').count(), 0, "계정 OFF는 reload 뒤에도 유지");

    const deepLinkY = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => {
      location.hash = "game-chat";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-composer="game-chat"]').count(), 0, "deep-link/hash로 OFF chat 재진입 금지");
    assert.equal(await page.evaluate(() => document.activeElement?.closest?.('[data-composer="game-chat"]') !== null), false, "deep-link 뒤 focus target 0");
    assert.ok(Math.abs((await page.evaluate(() => window.scrollY)) - deepLinkY) <= 2, "deep-link가 자동 스크롤을 만들지 않아야 한다");
    pass("OFF reload + deep-link focus/scroll 재진입 0");

    const otherRow = await admin.from("profiles").select("game_chat_enabled").eq("id", other.id).single();
    if (otherRow.error) throw otherRow.error;
    assert.equal(otherRow.data.game_chat_enabled, true, "다른 계정 설정은 영향 없어야 한다");
    pass("계정 격리");

    await page.getByRole("button", { name: "전체 채팅 켜기" }).click();
    await page.getByRole("button", { name: "전체 채팅 끄기" }).waitFor({ state: "visible" });
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "전체 채팅 끄기" }).waitFor({ state: "visible" });
    assert.deepEqual(await apiPreference(page, owner.session.access_token, "GET"), { status: 200, body: { visible: true } }, "PUT ON→reload→GET=true");
    pass("PUT ON→GET→reload ON");

    await page.route("**/api/game-chat/prefs", async (route) => {
      if (route.request().method() === "PUT") await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"injected"}' });
      else await route.continue();
    });
    await page.getByRole("button", { name: "전체 채팅 끄기" }).click();
    await page.getByRole("button", { name: "전체 채팅 끄기" }).waitFor({ state: "visible" });
    assert.equal(await page.locator('[data-composer="game-chat"]').count(), 1, "PUT 실패 시 ON rollback");
    assert.deepEqual(await apiPreference(page, owner.session.access_token, "GET"), { status: 200, body: { visible: true } }, "PUT 실패 시 DB도 ON 유지");
    pass("저장 실패 optimistic rollback");
    await context.close();
  } finally {
    for (const id of users) {
      const problems = [];
      try {
        const deleted = await admin.from("profiles").delete().eq("id", id);
        if (deleted.error) problems.push(`profile delete: ${deleted.error.message}`);
      } catch (error) { problems.push(`profile delete threw: ${error.message}`); }
      try {
        const deleted = await admin.auth.admin.deleteUser(id);
        if (deleted.error) problems.push(`auth delete: ${deleted.error.message}`);
      } catch (error) { problems.push(`auth delete threw: ${error.message}`); }
      try {
        const profile = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("id", id);
        if (profile.error || (profile.count ?? 0) !== 0) problems.push(`profile postcondition: ${profile.error?.message ?? profile.count}`);
      } catch (error) { problems.push(`profile postcondition threw: ${error.message}`); }
      try {
        const auth = await admin.auth.admin.getUserById(id);
        if (auth.data?.user || (auth.error && !/not.?found/i.test(auth.error.message))) problems.push(`auth postcondition: ${auth.error?.message ?? "user remains"}`);
      } catch (error) { problems.push(`auth postcondition threw: ${error.message}`); }
      if (problems.length) {
        cleanupFailed = true;
        console.error(`cleanup FAIL ${id}: ${problems.join("; ")}`);
      }
    }
    assert.equal(cleanupFailed, false, "전용 계정/profile cleanup postcondition");
    pass(`전용 계정 ${users.length}개 cleanup + 잔존 0`);
  }
}

try {
  if (authActual) await authActualSmoke();
  else await guestSmoke();
  console.log(`ui-smoke-game-chat-visibility: PASS (${authActual ? "auth actual" : "guest"})`);
} finally {
  await browser.close();
}
