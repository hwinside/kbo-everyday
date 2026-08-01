#!/usr/bin/env node
/**
 * 야잘알봇 아바타 End-User QA.
 *
 * 실제 로그인 사용자 세션으로 쪽지함/대화방을 열어
 *  - 아바타 <img> 가 마스코트 경로를 가리키는가
 *  - 그 이미지가 실제로 로드됐는가 (naturalWidth > 0 — 404 면 0)
 *  - ⚾ 이모지 잔존 0
 * 을 확인한다. src 문자열만 보는 검사는 파일이 없어도 통과하므로 금지.
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { SUPABASE_URL, ANON, SERVICE_ROLE, REF, BASE } from "./_env.mjs";

const BASE_URL = process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] ?? BASE;
const EXPECT_SRC = "/mascot/yajalal-avatar.png";
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now().toString(36);
const email = `qa-avatar-${stamp}@keubo.fan`;
const password = `QaAv!${stamp}`;
let userId = null;
let browser = null;
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function injectSession(context, session) {
  const key = `sb-${REF}-auth-token`;
  const value = JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    token_type: "bearer",
    user: session.user,
  });
  const url = new URL(BASE_URL);
  await context.addCookies([{
    name: key,
    value: `base64-${Buffer.from(value).toString("base64")}`,
    domain: url.hostname,
    path: "/",
    httpOnly: false,
    secure: url.protocol === "https:",
    sameSite: "Lax",
    expires: session.expires_at,
  }]);
  await context.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [key, value]);
}

try {
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (cErr) throw new Error(`createUser: ${cErr.message}`);
  userId = created.user.id;
  // ⚠️ ProfileSetupWrapper 는 profile.team_id 로 판정한다(favorite_team_id 아님).
  // 잘못된 컬럼을 넣으면 닉네임 설정 모달이 떠서 목록을 덮고, 스크린샷 증거가 무용지물이 된다.
  const { error: pErr } = await admin.from("profiles").upsert({
    id: userId, nickname: `QA아바타${stamp.slice(-4)}`, team_id: 1,
  });
  if (pErr) throw new Error(`profile upsert: ${pErr.message}`);

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`sign-in: ${res.status}`);
  const session = await res.json();

  browser = await playwright.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await injectSession(context, session);
  const page = await context.newPage();

  // ── 쪽지함 목록 ──────────────────────────────────────────
  await page.goto(`${BASE_URL}/messages`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // 신규 계정은 닉네임 설정 모달이 떠서 목록을 가린다.
  // 스크린샷 증거가 모달에 덮이면 육안 검수를 못 하므로 먼저 닫는다.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /건너뛰기|나중에|닫기|취소|확인/.test(b.textContent || ""));
    btn?.click();
  });
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(800);

  const list = await page.evaluate((expect) => {
    const rows = [...document.querySelectorAll("*")].filter(
      (el) => el.children.length === 0 && el.textContent.trim() === "야잘알봇");
    if (!rows.length) return { found: false };
    let card = rows[0];
    for (let i = 0; i < 8 && card; i++) {
      if (card.querySelector?.("img")) break;
      card = card.parentElement;
    }
    const img = card?.querySelector("img");
    return {
      found: true,
      hasImg: !!img,
      src: img?.getAttribute("src") ?? null,
      loaded: img ? img.naturalWidth > 0 && img.naturalHeight > 0 : false,
      natural: img ? `${img.naturalWidth}x${img.naturalHeight}` : null,
      box: img ? (() => { const r = img.getBoundingClientRect();
        return `${Math.round(r.width)}x${Math.round(r.height)}`; })() : null,
      matches: img?.getAttribute("src") === expect,
    };
  }, EXPECT_SRC);

  ok("쪽지함: 야잘알봇 행 존재", list.found);
  ok("쪽지함: 아바타 <img> 렌더", !!list.hasImg);
  ok("쪽지함: src 가 마스코트 경로", !!list.matches, `src=${list.src}`);
  ok("쪽지함: 이미지 실제 로드됨(404 아님)", !!list.loaded, `natural=${list.natural} box=${list.box}`);

  const emojiList = await page.evaluate(() =>
    [...document.querySelectorAll("*")].filter(
      (el) => el.children.length === 0 && el.textContent.trim() === "⚾").length);
  ok("쪽지함: ⚾ 이모지 잔존 0", emojiList === 0, `발견 ${emojiList}개`);

  // 스크린샷이 오버레이에 덮이면 육안 검수가 불가능하므로 그 자체를 실패로 본다.
  const overlay = await page.evaluate(() =>
    document.body.innerText.includes("환영합니다"));
  ok("쪽지함: 증거 스크린샷에 설정 모달 없음", !overlay);

  await page.screenshot({ path: "tmp/qa-screenshots/genius-avatar-list.png" });

  // ── 대화방 헤더 ─────────────────────────────────────────
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("*")].find(
      (e) => e.children.length === 0 && e.textContent.trim() === "야잘알봇");
    let c = el; for (let i = 0; i < 8 && c; i++) { if (c.onclick || c.getAttribute("role")) break; c = c.parentElement; }
    (c ?? el)?.click();
  });
  await page.waitForTimeout(2500);

  const header = await page.evaluate((expect) => {
    const h = document.querySelector("h1");
    const img = h?.parentElement?.querySelector("img");
    return {
      url: location.pathname,
      title: h?.textContent?.trim() ?? null,
      src: img?.getAttribute("src") ?? null,
      loaded: img ? img.naturalWidth > 0 : false,
      box: img ? (() => { const r = img.getBoundingClientRect();
        return `${Math.round(r.width)}x${Math.round(r.height)}`; })() : null,
      matches: img?.getAttribute("src") === expect,
    };
  }, EXPECT_SRC);

  ok("대화방: 진입 성공", header.url.startsWith("/messages/"), `path=${header.url} title=${header.title}`);
  ok("대화방: 헤더 src 가 마스코트 경로", !!header.matches, `src=${header.src}`);
  ok("대화방: 헤더 이미지 실제 로드됨", !!header.loaded, `box=${header.box}`);

  const emojiChat = await page.evaluate(() =>
    [...document.querySelectorAll("*")].filter(
      (el) => el.children.length === 0 && el.textContent.trim() === "⚾").length);
  ok("대화방: ⚾ 이모지 잔존 0", emojiChat === 0, `발견 ${emojiChat}개`);

  await page.screenshot({ path: "tmp/qa-screenshots/genius-avatar-chat.png" });
} catch (e) {
  ok("스모크 실행", false, e.message);
} finally {
  if (browser) await browser.close();
  if (userId) {
    await admin.from("profiles").delete().eq("id", userId);
    await admin.auth.admin.deleteUser(userId);
    console.log("  (테스트 계정 정리 완료)");
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\ngenius avatar UI: PASS=${results.length - failed.length} FAIL=${failed.length}`);
process.exit(failed.length ? 1 : 0);
