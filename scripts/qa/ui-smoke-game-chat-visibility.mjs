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

// 크관 자동 포커싱 토글 (PR #1291) — 순서/overflow(320·390px) + 스크롤 ON/OFF/영속/복귀.
// 스크롤 축은 라이브 경기 없이 재현하기 위해 /qa/kgwan-autofocus 픽스처(실제 hook +
// 실제 CurrentAtBatCard scrollOnUpdate 배선)를 태운다.
async function autofocusSmoke() {
  // ① 게임 페이지 — 버튼 순서(토글이 채팅 끄기 왼쪽) + 가로 overflow, 390/320px.
  for (const width of [390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.goto(`${baseUrl}${gamePath}`, { waitUntil: "networkidle" });
    const toggle = page.getByRole("button", { name: /자동 포커싱 (끄기|켜기)/ });
    const hide = page.getByRole("button", { name: "전체 채팅 끄기" });
    await toggle.waitFor({ state: "visible" });
    await hide.waitFor({ state: "visible" });
    const [toggleBox, hideBox] = [await toggle.boundingBox(), await hide.boundingBox()];
    assert.ok(toggleBox && hideBox, `${width}px: 두 버튼 bounding box`);
    assert.ok(toggleBox.x + toggleBox.width <= hideBox.x, `${width}px: 토글이 채팅 끄기 왼쪽에 있어야 한다`);
    assert.ok(Math.abs(toggleBox.y - hideBox.y) < Math.max(toggleBox.height, hideBox.height), `${width}px: 같은 행에 있어야 한다(줄바꿈 금지)`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}px 가로 overflow가 없어야 한다`);
    await page.close();
    pass(`autofocus 버튼 순서/행/overflow @${width}px`);
  }

  // ② 픽스처 — 새 투구 자동 스크롤 ON/OFF 실제 거동 + reload 영속 + ON 복귀.
  const fixturePath = "/qa/kgwan-autofocus";
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  // sr-only 버튼은 viewport 밖이어도 동작해야 하므로 DOM click 이벤트로 발화.
  const addPitch = () => page.locator('[data-qa="add-live-pitch"]').dispatchEvent("click");
  const scrollY = () => page.evaluate(() => window.scrollY);
  const settle = async () => { await page.waitForTimeout(700); };

  await page.goto(`${baseUrl}${fixturePath}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "자동 포커싱 끄기" }).waitFor({ state: "visible" });
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.equal(await scrollY(), 0, "픽스처 초기 scrollY=0");
  await addPitch();
  await page.waitForFunction(() => window.scrollY > 0, undefined, { timeout: 3000 });
  pass("기본 ON: 새 투구 → 자동 스크롤 발생");

  await page.getByRole("button", { name: "자동 포커싱 끄기" }).click();
  await page.getByRole("button", { name: "자동 포커싱 켜기" }).waitFor({ state: "visible" });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  await addPitch();
  await settle();
  assert.equal(await scrollY(), 0, "OFF: 새 투구가 자동 스크롤을 만들면 안 된다");
  assert.equal(await page.evaluate(() => window.localStorage.getItem("***")), "off", "OFF가 localStorage에 영속되어야 한다");
  pass("OFF: 새 투구 무스크롤 + localStorage 영속");

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "자동 포커싱 켜기" }).waitFor({ state: "visible" });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  await addPitch();
  await settle();
  assert.equal(await scrollY(), 0, "reload 후에도 OFF 유지(무스크롤)");
  pass("reload 영속: OFF 유지");

  await page.getByRole("button", { name: "자동 포커싱 켜기" }).click();
  await page.getByRole("button", { name: "자동 포커싱 끄기" }).waitFor({ state: "visible" });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  await addPitch();
  await page.waitForFunction(() => window.scrollY > 0, undefined, { timeout: 3000 });
  pass("ON 복귀: 새 투구 → 자동 스크롤 재개");
  await page.close();

  // ③ localStorage.setItem throw actual — 쓰기 실패 환경(사파리 시크릿 등)에서도
  //    세션 내 토글이 실제로 동작해야 한다 (삼순 blocker — 정적 검사 아닌 행위 실측).
  const throwPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await throwPage.addInitScript(() => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItemBlocked(key, ...args) {
      if (key === "***") throw new Error("qa: setItem blocked");
      return orig.call(this, key, ...args);
    };
  });
  const throwPitch = () => throwPage.locator('[data-qa="add-live-pitch"]').dispatchEvent("click");
  await throwPage.goto(`${baseUrl}${fixturePath}`, { waitUntil: "networkidle" });
  await throwPage.getByRole("button", { name: "자동 포커싱 끄기" }).waitFor({ state: "visible" });
  await throwPage.getByRole("button", { name: "자동 포커싱 끄기" }).click();
  // 쓰기가 throw해도 버튼 상태가 전환되어야 한다(메모리 1차 소스 계약).
  await throwPage.getByRole("button", { name: "자동 포커싱 켜기" }).waitFor({ state: "visible", timeout: 3000 });
  assert.equal(
    await throwPage.evaluate(() => window.localStorage.getItem("***")),
    null,
    "setItem이 실제로 차단되었는지 확인(영속 안 됨) — 안 막혔으면 이 축 자체가 무효",
  );
  await throwPage.evaluate(() => window.scrollTo(0, 0));
  await throwPage.waitForTimeout(100);
  await throwPitch();
  await throwPage.waitForTimeout(700);
  assert.equal(await throwPage.evaluate(() => window.scrollY), 0, "쓰기 실패 환경에서도 OFF가 적용되어 무스크롤이어야 한다");
  await throwPage.getByRole("button", { name: "자동 포커싱 켜기" }).click();
  await throwPage.getByRole("button", { name: "자동 포커싱 끄기" }).waitFor({ state: "visible", timeout: 3000 });
  await throwPage.evaluate(() => window.scrollTo(0, 0));
  await throwPage.waitForTimeout(100);
  await throwPitch();
  await throwPage.waitForFunction(() => window.scrollY > 0, undefined, { timeout: 3000 });
  pass("localStorage.setItem throw: 토글 OFF→무스크롤→ON 복귀 세션 내 정상(영속만 포기)");
  await throwPage.close();
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
  await autofocusSmoke();
  console.log(`ui-smoke-game-chat-visibility: PASS (${authActual ? "auth actual" : "guest"} + autofocus)`);
} finally {
  await browser.close();
}
