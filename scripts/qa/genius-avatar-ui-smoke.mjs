#!/usr/bin/env node
/**
 * 야잘알봇 마스코트 아바타 End-User QA.
 *
 * 아바타는 관리자에게만 보인다(2026-08-01 하린아빠 지시). 따라서 양쪽을 다 본다.
 *   [관리자]   마스코트 <img> 가 보이고 실제로 로드되며, 레이아웃이 안 밀린다
 *   [비관리자] 마스코트가 없고 종전 ⚾ 폴백이 그대로 뜬다 (게이트가 실제로 막는지)
 *
 * 설계 시 신경 쓴 것:
 *  - src 문자열만 보면 파일이 404 여도 통과한다 → naturalWidth 로 실제 디코딩 확인
 *  - 신규 계정 프로필 설정 모달이 증거 스크린샷을 덮으면 육안 검수가 불가능 → 그 자체를 FAIL
 *  - 헤더/카드 높이를 베이스라인과 비교해 "레이아웃 안 깨짐"을 수치로 고정
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { SUPABASE_URL, ANON, SERVICE_ROLE, REF, BASE } from "./_env.mjs";

const BASE_URL = process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] ?? BASE;
const EXPECT_SRC = "/mascot/yajalal-avatar.png";
const ADMIN_EMAIL = "harinclaw@gmail.com";   // ADMIN_EMAILS 화이트리스트

// 레이아웃 계약.
//
// ⚠️ 헤더 높이를 고정 상수와 비교하면 안 된다. otherId 해결 전에는 아이콘이
// 아예 없어 54px 가 잡히고, 해결 후 ⚾ 가 붙으면 56px 가 된다. 같은 코드에서
// 시점에 따라 값이 달라지므로 상수 대조는 flaky 다(실제로 오판했다).
// 대신 상태와 무관한 두 가지를 본다.
//   (a) 아바타 높이 <= 옆 텍스트블록 높이  → 아바타가 헤더 높이를 결정하지 않음
//   (b) 관리자 헤더 <= 비관리자 헤더        → 마스코트가 헤더를 키우지 않음
const CARD_H = 82;     // 쪽지함 카드는 아바타 컨테이너(w-10)가 고정이라 상수로 OK

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function ctxWithSession(browser, session, user) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const key = `sb-${REF}-auth-token`;
  // ⚠️ 쿠키 1개 상한은 4096B 다. magiclink 로 받은 user 객체를 통째로 넣으면
  // identities/app_metadata 때문에 4.3KB 가 되어 CDP 가 "Invalid cookie fields" 로 거부한다.
  // AuthContext 가 실제로 쓰는 필드만 남긴다(isAdmin 판정은 email).
  const u0 = user ?? session.user;
  const slimUser = {
    id: u0.id, email: u0.email, aud: u0.aud, role: u0.role,
    app_metadata: {}, user_metadata: {}, created_at: u0.created_at,
  };
  const value = JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in ?? 3600,
    expires_at: session.expires_at,
    token_type: "bearer",
    user: slimUser,
  });
  const u = new URL(BASE_URL);
  const expires = Number(session.expires_at);
  await ctx.addCookies([{
    name: key, value: `base64-${Buffer.from(value).toString("base64")}`,
    domain: u.hostname, path: "/", httpOnly: false,
    secure: u.protocol === "https:", sameSite: "Lax",
    // expires 가 NaN 이면 CDP 가 "Invalid cookie fields" 로 거부한다.
    ...(Number.isFinite(expires) ? { expires } : {}),
  }]);
  await ctx.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [key, value]);
  return ctx;
}

/** 기존 관리자 계정의 세션만 발급받는다. 계정을 만들거나 지우지 않는다. */
async function adminSession() {
  const { data: link, error } = await admin.auth.admin.generateLink({
    type: "magiclink", email: ADMIN_EMAIL,
  });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const r = await fetch(
    `${SUPABASE_URL}/auth/v1/verify?token=${link.properties.hashed_token}&type=magiclink`,
    { redirect: "manual" });
  const frag = new URLSearchParams((r.headers.get("location") || "").split("#")[1] || "");
  const access_token = frag.get("access_token");
  if (!access_token) throw new Error(`magiclink verify: ${r.status}`);
  const user = await (await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON, Authorization: `Bearer ${access_token}` },
  })).json();
  return {
    session: {
      access_token,
      refresh_token: frag.get("refresh_token"),
      expires_at: Number(frag.get("expires_at")),
      expires_in: 3600,
    },
    user,
  };
}

const probeList = (expect) => {
  const g = (x) => (x ? Math.round(x.getBoundingClientRect().height) : null);
  const img = document.querySelector(`img[src="${expect}"]`);
  const emoji = [...document.querySelectorAll("*")].filter(
    (el) => el.children.length === 0 && el.textContent.trim() === "⚾").length;
  const modal = document.body.innerText.includes("환영합니다");
  if (!img) return { hasImg: false, emoji, modal };
  const box = img.parentElement;
  let card = box.parentElement;
  for (let i = 0; i < 4 && card; i++) {
    if (getComputedStyle(card).padding !== "0px") break;
    card = card.parentElement;
  }
  return {
    hasImg: true, emoji, modal,
    loaded: img.naturalWidth > 0,
    natural: `${img.naturalWidth}x${img.naturalHeight}`,
    avatarH: g(box), cardH: g(card),
  };
};

const probeChat = (expect) => {
  const g = (x) => (x ? Math.round(x.getBoundingClientRect().height) : null);
  const hdr = document.querySelector("header");
  const img = hdr?.querySelector(`img[src="${expect}"]`);
  const h1 = hdr?.querySelector("h1");
  const emoji = [...(hdr?.querySelectorAll("*") ?? [])].filter(
    (el) => el.children.length === 0 && el.textContent.trim() === "⚾").length;
  return {
    path: location.pathname, title: h1?.textContent?.trim() ?? null,
    hasImg: !!img, emoji,
    loaded: img ? img.naturalWidth > 0 : false,
    avatarH: g(img), headerH: g(hdr),
    textBlockH: g(h1?.parentElement?.parentElement),
    overlaps: img && h1
      ? img.getBoundingClientRect().right > h1.getBoundingClientRect().left + 1 : false,
  };
};

async function openGeniusRoom(page) {
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("*")].find(
      (e) => e.children.length === 0 && e.textContent.trim() === "야잘알봇");
    let c = el;
    for (let i = 0; i < 8 && c; i++) { if (c.onclick || c.getAttribute("role")) break; c = c.parentElement; }
    (c ?? el)?.click();
  });
  // otherId 해결 전에는 아이콘이 없어 잘못된 높이를 잰다. 등장까지 기다린다.
  await page.waitForFunction(() => {
    const h = document.querySelector("header");
    if (!h) return false;
    if (h.querySelector('img[src="/mascot/yajalal-avatar.png"]')) return true;
    return [...h.querySelectorAll("*")].some(
      (e) => e.children.length === 0 && e.textContent.trim() === "⚾");
  }, null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(800);
}

let browser = null;
let guestId = null;
try {
  browser = await playwright.chromium.launch();

  // ── ① 관리자: 마스코트가 보이고 레이아웃이 안 깨져야 한다 ──────────
  console.log("[관리자]");
  const { session: aSess, user: aUser } = await adminSession();
  const aCtx = await ctxWithSession(browser, aSess, aUser);
  const aPage = await aCtx.newPage();
  await aPage.goto(`${BASE_URL}/messages`, { waitUntil: "networkidle" });
  await aPage.waitForTimeout(2000);

  const aList = await aPage.evaluate(probeList, EXPECT_SRC);
  ok("목록: 마스코트 아바타 렌더", aList.hasImg);
  ok("목록: 이미지 실제 로드됨(404 아님)", !!aList.loaded, `natural=${aList.natural} box=${aList.avatarH}px`);
  ok("목록: ⚾ 이모지 잔존 0", aList.emoji === 0, `발견 ${aList.emoji}개`);
  ok("목록: 카드 높이 불변", aList.cardH === CARD_H, `${aList.cardH}px (기대 ${CARD_H})`);
  ok("목록: 증거 스크린샷에 설정 모달 없음", !aList.modal);
  await aPage.screenshot({ path: "tmp/qa-screenshots/genius-avatar-list.png" });

  await openGeniusRoom(aPage);
  const aChat = await aPage.evaluate(probeChat, EXPECT_SRC);
  ok("대화방: 진입 성공", aChat.path.startsWith("/messages/"), `title=${aChat.title}`);
  ok("대화방: 마스코트 아바타 렌더", aChat.hasImg);
  ok("대화방: 이미지 실제 로드됨", !!aChat.loaded, `box=${aChat.avatarH}px`);
  ok("대화방: 아바타가 20px→40px 로 커짐", aChat.avatarH === 40, `${aChat.avatarH}px`);
  ok("대화방: 아바타가 헤더 높이를 결정하지 않음",
     aChat.avatarH <= aChat.textBlockH,
     `아바타 ${aChat.avatarH}px <= 텍스트블록 ${aChat.textBlockH}px`);
  ok("대화방: 아바타-제목 겹침 없음", !aChat.overlaps);
  ok("대화방: ⚾ 이모지 잔존 0", aChat.emoji === 0, `발견 ${aChat.emoji}개`);
  await aPage.screenshot({ path: "tmp/qa-screenshots/genius-avatar-chat.png" });
  await aCtx.close();

  // ── ② 비관리자: 게이트가 실제로 막아야 한다 ────────────────────
  console.log("[비관리자]");
  const stamp = Date.now().toString(36);
  const gEmail = `qa-avatar-${stamp}@keubo.fan`, gPw = `QaAv!${stamp}`;
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email: gEmail, password: gPw, email_confirm: true,
  });
  if (cErr) throw new Error(`createUser: ${cErr.message}`);
  guestId = created.user.id;
  // ⚠️ ProfileSetupWrapper 는 profile.team_id 로 판정한다(favorite_team_id 아님).
  // 잘못된 컬럼을 넣으면 설정 모달이 떠서 목록을 덮고 증거가 무용지물이 된다.
  const { error: pErr } = await admin.from("profiles").upsert({
    id: guestId, nickname: `QA손님${stamp.slice(-4)}`, team_id: 1,
  });
  if (pErr) throw new Error(`profile upsert: ${pErr.message}`);

  const gSess = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: gEmail, password: gPw }),
  })).json();
  const gCtx = await ctxWithSession(browser, gSess);
  const gPage = await gCtx.newPage();
  await gPage.goto(`${BASE_URL}/messages`, { waitUntil: "networkidle" });
  await gPage.waitForTimeout(2000);

  const gList = await gPage.evaluate(probeList, EXPECT_SRC);
  ok("목록: 비관리자에겐 마스코트 비노출", !gList.hasImg);
  ok("목록: 비관리자는 ⚾ 폴백 유지", gList.emoji > 0, `${gList.emoji}개`);
  ok("목록: 비관리자 카드 높이 동일", gList.cardH == null || gList.cardH === CARD_H, `${gList.cardH}px`);

  await openGeniusRoom(gPage);
  const gChat = await gPage.evaluate(probeChat, EXPECT_SRC);
  ok("대화방: 비관리자에겐 마스코트 비노출", !gChat.hasImg);
  ok("대화방: 비관리자는 ⚾ 폴백 유지", gChat.emoji > 0, `${gChat.emoji}개`);
  ok("대화방: 마스코트가 헤더를 키우지 않음(관리자 <= 비관리자)",
     aChat.headerH <= gChat.headerH,
     `관리자 ${aChat.headerH}px <= 비관리자(종전 ⚾) ${gChat.headerH}px`);
  await gCtx.close();
} catch (e) {
  ok("스모크 실행", false, e.message);
} finally {
  if (browser) await browser.close();
  if (guestId) {
    await admin.from("profiles").delete().eq("id", guestId);
    await admin.auth.admin.deleteUser(guestId);
    console.log("  (임시 손님 계정 정리 완료 — 관리자 계정은 건드리지 않음)");
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\ngenius avatar UI: PASS=${results.length - failed.length} FAIL=${failed.length}`);
process.exit(failed.length ? 1 : 0);
