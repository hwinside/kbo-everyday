#!/usr/bin/env node
/**
 * 야잘알봇 마스코트 아바타 End-User QA.
 *
 * 공개 롤아웃 계약: 서로 다른 일반 사용자 2명 모두 마스코트를 보고 레이아웃이 동일해야 한다.
 * 하린아빠 개인/공유 계정은 QA에 사용하지 않고 실행마다 전용 계정을 만든 뒤 검증 후 삭제한다.
 *
 * 설계 시 신경 쓴 것:
 *  - src 문자열만 보면 파일이 404 여도 통과한다 → naturalWidth 로 실제 디코딩 확인
 *  - 신규 계정 프로필 설정 모달이 증거 스크린샷을 덮으면 육안 검수가 불가능 → 그 자체를 FAIL
 *  - 헤더/카드 높이를 베이스라인과 비교해 "레이아웃 안 깨짐"을 수치로 고정
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUPABASE_URL, ANON, SERVICE_ROLE, REF, BASE } from "./_env.mjs";
import {
  GENIUS_ALPHA_CUTOFF,
  measureVisibleAlphaBounds,
} from "./genius-avatar-alpha-contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] ?? BASE;
const EXPECT_SRC = "/mascot/yajalal-avatar.png";

// 레이아웃 계약 (삼순 확정 규격 2026-08-01).
//
//   목록   : 카드 높이 82px 유지, 캐릭터 가시 높이 >= 50px
//   대화방 : 슬롯 96px, 캐릭터 가시 높이 >= 72px, 헤더 108~112px
//
// "레이아웃이 안 깨진다" 는 아바타를 안 키우는 것과 다르다. 헤더는 커져도
// 되고(삼순이 108~112px 를 명시 요구), 깨지면 안 되는 건 카드 한 줄 구조,
// 제목/설명 두 줄, 뒤로가기 정렬, 가로 overflow 다. 그래서 상수 비교 대신
// 그 네 가지를 직접 본다.
const CARD_H = 82;              // 카드 높이는 아바타를 넘치게 그려도 불변이어야 한다
const LIST_MIN_VISIBLE = 50;    // 목록 캐릭터 최소 가시 높이
const CHAT_SLOT = 96;           // 대화방 슬롯
const CHAT_MIN_VISIBLE = 72;    // 대화방 캐릭터 최소 가시 높이
// 헤더 게이트는 삼순 합의 규격 그대로 108~112px 로 고정한다 (삼순 NO-GO).
// 104~120 으로 넓혀두면 규격을 벗어난 레이아웃도 통과해 게이트가 의미를 잃는다.
// safe-area 편차를 핑계로 넓히지 않는다 — 아래 뷰포트를 390x844 로 고정해
// env(safe-area-inset-top) 이 0 인 결정론적 조건에서만 측정한다.
const CHAT_HEADER_MIN = 108;
const CHAT_HEADER_MAX = 112;
const VIEWPORT = { width: 390, height: 844 };
// 정적 자산과 브라우저 렌더가 같은 기준을 쓴다. PNG의 투명 테두리는 제거해
// 래스터 반올림 뒤에도 가로·세로 alpha bbox가 0.98 아래로 내려가지 않는다.
const MIN_ALPHA_BBOX_RATIO = 0.98;

// 대화방 부제 문구 (하린아빠 2026-08-01 확정)
const GENIUS_SUBTITLE = "야구 밖에 모르는 바보 AI봇";

/**
 * PNG 의 불투명 영역 세로 비율을 실측한다.
 *
 * <img> 의 getBoundingClientRect().height 는 **투명 여백까지 포함한 박스**다.
 * 자산 위아래에 투명 패딩이 생기면 박스는 그대로인데 실제 캐릭터는 작아진다 —
 * 그런 회귀를 박스 기준 assert 는 못 잡는다(삼순 NO-GO). 그래서 알파 bbox 비율을
 * 곱해 "화면에서 실제로 보이는 캐릭터 높이" 로 판정한다.
 */
async function alphaBboxRatio(publicPath) {
  const file = path.join(process.cwd(), "public", publicPath.replace(/^\//, ""));
  const img = sharp(readFileSync(file));
  const { width, height } = await img.metadata();
  const buf = await img.raw().ensureAlpha().toBuffer();
  const bounds = measureVisibleAlphaBounds(buf, { width, height, channels: 4 });
  if (!bounds) throw new Error(`${publicPath}: 불투명 픽셀 0 (alpha>${GENIUS_ALPHA_CUTOFF})`);
  return {
    ratio: (bounds.maxY - bounds.minY + 1) / height,
    top: bounds.minY,
    bottom: bounds.maxY,
    height,
  };
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function verifyAlphaCutoffContract() {
  const fixture = Buffer.from([
    0, 0, 0, 1,
    0, 0, 0, 9,
  ]);
  const strict = measureVisibleAlphaBounds(fixture, { width: 2, height: 1, channels: 4 });
  const legacy = measureVisibleAlphaBounds(fixture, { width: 2, height: 1, channels: 4 }, 0);
  ok(
    `contract: 정적·브라우저 공용 alpha cutoff=${GENIUS_ALPHA_CUTOFF}`,
    strict?.minX === 1 && strict.maxX === 1 && legacy?.minX === 0 && legacy.maxX === 1,
    "alpha 1은 제외하고 alpha 9부터 가시 픽셀",
  );
}

async function ctxWithSession(browser, session, user) {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
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

async function createTestSession(label) {
  const stamp = `${Date.now().toString(36)}-${label}`;
  const email = `qa-avatar-${stamp}@keubo-test.local`;
  const password = `QaAv!${stamp}`;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (createError || !created.user) throw new Error(`createUser: ${createError?.message ?? "user missing"}`);
  testUserIds.push(created.user.id);
  const { error: profileError } = await admin.from("profiles").upsert({
    id: created.user.id, nickname: `QA아바타${label}`, team_id: 1,
  });
  if (profileError) throw new Error(`profile upsert: ${profileError.message}`);
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const session = await response.json();
  if (!response.ok || !session.access_token) throw new Error(`test sign-in: ${response.status}`);
  return { session, user: created.user };
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
  const ib = img.getBoundingClientRect();
  const cb = card?.getBoundingClientRect();
  const nick = card?.querySelector("span");
  return {
    hasImg: true, emoji, modal,
    loaded: img.naturalWidth > 0,
    natural: `${img.naturalWidth}x${img.naturalHeight}`,
    slotH: g(box),
    visibleH: Math.round(ib.height),      // 실제 캐릭터가 보이는 높이(슬롯을 넘칠 수 있다)
    cardH: g(card),
    // 카드가 한 줄 구조를 유지하는가 = 아바타가 카드 세로 안에 담기는가
    withinCard: cb ? ib.top >= cb.top - 1 && ib.bottom <= cb.bottom + 1 : false,
    nickX: nick ? Math.round(nick.getBoundingClientRect().left) : null,
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

const probeChat = (expect) => {
  const g = (x) => (x ? Math.round(x.getBoundingClientRect().height) : null);
  const hdr = document.querySelector("header");
  const img = hdr?.querySelector(`img[src="${expect}"]`);
  const h1 = hdr?.querySelector("h1");
  const emoji = [...(hdr?.querySelectorAll("*") ?? [])].filter(
    (el) => el.children.length === 0 && el.textContent.trim() === "⚾").length;
  const back = hdr?.querySelector("button");
  const sub = h1?.parentElement?.parentElement?.querySelector("p");
  const ib = img?.getBoundingClientRect();
  const hb = hdr?.getBoundingClientRect();
  return {
    path: location.pathname, title: h1?.textContent?.trim() ?? null,
    hasImg: !!img, emoji,
    loaded: img ? img.naturalWidth > 0 : false,
    visibleH: ib ? Math.round(ib.height) : null,
    headerH: g(hdr),
    subtitle: sub?.textContent?.trim() ?? null,   // 설명 줄이 살아있는가
    // 캐릭터가 헤더 밖으로 삐져나오지 않는가
    withinHeader: ib && hb ? ib.bottom <= hb.bottom + 1 : false,
    // 뒤로가기/텍스트/헤더 세로 중심 (헤더 상단 기준 오프셋)
    backCy: back ? Math.round((back.getBoundingClientRect().top + back.getBoundingClientRect().bottom) / 2 - hb.top) : null,
    textCy: h1?.parentElement?.parentElement
      ? Math.round((h1.parentElement.parentElement.getBoundingClientRect().top
                  + h1.parentElement.parentElement.getBoundingClientRect().bottom) / 2 - hb.top) : null,
    headerCy: hb ? Math.round(hb.height / 2) : null,
    padTop: hdr ? getComputedStyle(hdr).paddingTop : null,
    padBottom: hdr ? getComputedStyle(hdr).paddingBottom : null,
    overlaps: img && h1
      ? ib.right > h1.getBoundingClientRect().left + 1 : false,
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
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
const testUserIds = [];
try {
  verifyAlphaCutoffContract();
  const listSource = readFileSync(path.join(HERE, "../../src/app/(main)/messages/page.tsx"), "utf8");
  const chatSource = readFileSync(path.join(HERE, "../../src/app/(main)/messages/[conversationId]/page.tsx"), "utf8");
  ok("source: 목록은 nickname이 아닌 bot user_id로 판정",
     /conv\.other_user_id === BASEBALL_GENIUS_USER_ID/.test(listSource)
       && !/other_nickname === BASEBALL_GENIUS_NAME/.test(listSource));
  ok("source: 관리자 gate 0", !/AdminOnly|useIsAdmin/.test(`${listSource}\n${chatSource}`));

  const asset = await sharp(path.join(HERE, "../../public/mascot/yajalal-avatar.png"))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bounds = measureVisibleAlphaBounds(asset.data, asset.info);
  if (!bounds) throw new Error(`마스코트 가시 픽셀 0 (alpha>${GENIUS_ALPHA_CUTOFF})`);
  const { minX, minY, maxX, maxY } = bounds;
  const alphaWidthRatio = (maxX - minX + 1) / asset.info.width;
  const alphaHeightRatio = (maxY - minY + 1) / asset.info.height;
  ok(`asset: 알파 bbox 가로·세로 비율 >= ${MIN_ALPHA_BBOX_RATIO.toFixed(6)}`,
     alphaWidthRatio >= MIN_ALPHA_BBOX_RATIO && alphaHeightRatio >= MIN_ALPHA_BBOX_RATIO,
     `${alphaWidthRatio.toFixed(3)}×${alphaHeightRatio.toFixed(3)}`);
  if (process.argv.includes("--static-only")) {
    const staticFailed = results.filter((result) => !result.pass);
    console.log(`\ngenius avatar static: PASS=${results.length - staticFailed.length} FAIL=${staticFailed.length}`);
    process.exit(staticFailed.length ? 1 : 0);
  }

  browser = await playwright.chromium.launch();

  // ── ① 일반 사용자 A: 공개 마스코트 + 레이아웃 ───────────────────
  console.log("[일반 사용자 A]");
  const { session: aSess, user: aUser } = await createTestSession("A");
  const aCtx = await ctxWithSession(browser, aSess, aUser);
  const aPage = await aCtx.newPage();
  await aPage.goto(`${BASE_URL}/messages`, { waitUntil: "networkidle" });
  await aPage.waitForTimeout(2000);

  const aList = await aPage.evaluate(probeList, EXPECT_SRC);
  ok("목록: 마스코트 아바타 렌더", aList.hasImg);
  ok("목록: 이미지 실제 로드됨(404 아님)", !!aList.loaded, `natural=${aList.natural}`);
  // ⚠️ <img> 박스가 아니라 **알파 bbox 실측**으로 판정한다 (삼순 NO-GO).
  // 자산에 투명 패딩이 생기면 박스 높이는 그대로인데 캐릭터만 작아진다 — 박스 기준은 못 잡는다.
  const alphaList = await alphaBboxRatio(EXPECT_SRC);
  const listVisible = Math.round(aList.visibleH * alphaList.ratio);
  ok(`목록: 캐릭터 실제(알파) 가시 높이 >= ${LIST_MIN_VISIBLE}px`,
     listVisible >= LIST_MIN_VISIBLE,
     `${listVisible}px = 박스 ${aList.visibleH}px x 알파비 ${alphaList.ratio.toFixed(3)} (슬롯 ${aList.slotH}px)`);
  ok("자산에 상하 투명 패딩이 없다(크롭 유지)",
     alphaList.ratio >= 0.98,
     `알파비 ${alphaList.ratio.toFixed(3)} (top=${alphaList.top} bottom=${alphaList.bottom} h=${alphaList.height})`);
  ok("목록: 캐릭터가 카드 세로 안에 담김(한 줄 구조 유지)", aList.withinCard);
  ok("목록: 가로 overflow 0", aList.docOverflow <= 0, `${aList.docOverflow}px`);
  ok("목록: ⚾ 이모지 잔존 0", aList.emoji === 0, `발견 ${aList.emoji}개`);
  ok("목록: 카드 높이 불변", aList.cardH === CARD_H, `${aList.cardH}px (기대 ${CARD_H})`);
  ok("목록: 증거 스크린샷에 설정 모달 없음", !aList.modal);
  await aPage.screenshot({ path: "tmp/qa-screenshots/genius-avatar-list.png" });

  await openGeniusRoom(aPage);
  const aChat = await aPage.evaluate(probeChat, EXPECT_SRC);
  ok("대화방: 진입 성공", aChat.path.startsWith("/messages/"), `title=${aChat.title}`);
  ok("대화방: 마스코트 아바타 렌더", aChat.hasImg);
  ok("대화방: 이미지 실제 로드됨", !!aChat.loaded);
  const chatVisible = Math.round(aChat.visibleH * alphaList.ratio);
  ok(`대화방: 캐릭터 실제(알파) 가시 높이 >= ${CHAT_MIN_VISIBLE}px`,
     chatVisible >= CHAT_MIN_VISIBLE,
     `${chatVisible}px = 박스 ${aChat.visibleH}px x 알파비 ${alphaList.ratio.toFixed(3)} (슬롯 ${CHAT_SLOT}px)`);
  ok(`대화방: 헤더 ${CHAT_HEADER_MIN}~${CHAT_HEADER_MAX}px`,
     aChat.headerH >= CHAT_HEADER_MIN && aChat.headerH <= CHAT_HEADER_MAX, `${aChat.headerH}px`);
  ok("대화방: 캐릭터가 헤더 밖으로 안 삐져나옴", aChat.withinHeader);
  ok("대화방: 제목/설명 두 줄 유지", aChat.subtitle === GENIUS_SUBTITLE, `설명='${aChat.subtitle}'`);
  // ⚠️ 뒤로가기를 '헤더 세로 중심'과 비교하면 안 된다. 헤더 padding 이
  // 비대칭이라(pt-safe=0 / pb-3=12px) flex 콘텐츠 중심은 헤더 중심보다 항상
  // 6~7px 위다 — 관리자 48 vs 55, 비관리자 22 vs 28 로 마스코트와 무관하게
  // 동일하다. 즉 그 차이는 회귀가 아니라 기존 레이아웃 상수다.
  // 실제 계약은 "뒤로가기와 텍스트블록이 같은 축에 정렬" 이다(items-center 형제).
  ok("대화방: 뒤로가기-텍스트블록 세로 정렬 일치",
     aChat.backCy !== null && aChat.backCy === aChat.textCy,
     `back=${aChat.backCy} text=${aChat.textCy} (헤더중심 ${aChat.headerCy}, pad ${aChat.padTop}/${aChat.padBottom})`);
  ok("대화방: 아바타-제목 겹침 없음", !aChat.overlaps);
  ok("대화방: 가로 overflow 0", aChat.docOverflow <= 0, `${aChat.docOverflow}px`);
  ok("대화방: ⚾ 이모지 잔존 0", aChat.emoji === 0, `발견 ${aChat.emoji}개`);
  await aPage.screenshot({ path: "tmp/qa-screenshots/genius-avatar-chat.png" });
  await aCtx.close();

  // ── ② 일반 사용자 B: 관리자 allowlist와 무관하게 같은 공개 계약 ───
  console.log("[일반 사용자 B]");
  const { session: gSess } = await createTestSession("B");
  const gCtx = await ctxWithSession(browser, gSess);
  const gPage = await gCtx.newPage();
  await gPage.goto(`${BASE_URL}/messages`, { waitUntil: "networkidle" });
  await gPage.waitForTimeout(2000);

  const gList = await gPage.evaluate(probeList, EXPECT_SRC);
  ok("목록: 일반 사용자 B도 마스코트 노출", gList.hasImg);
  ok("목록: 일반 사용자 B ⚾ 폴백 0", gList.emoji === 0, `${gList.emoji}개`);
  ok("목록: 사용자 간 카드 높이 동일", gList.cardH === CARD_H, `${gList.cardH}px`);

  await openGeniusRoom(gPage);
  const gChat = await gPage.evaluate(probeChat, EXPECT_SRC);
  ok("대화방: 일반 사용자 B도 마스코트 노출", gChat.hasImg);
  ok("대화방: 일반 사용자 B ⚾ 폴백 0", gChat.emoji === 0, `${gChat.emoji}개`);
  ok("대화방: 사용자 B 헤더 108~112px",
     gChat.headerH >= CHAT_HEADER_MIN && gChat.headerH <= CHAT_HEADER_MAX,
     `${gChat.headerH}px`);
  ok("대화방: 일반 사용자 B 가로 overflow 0", gChat.docOverflow <= 0, `${gChat.docOverflow}px`);
  ok("대화방: 일반 사용자 B도 뒤로가기-텍스트 정렬 일치",
     gChat.backCy !== null && gChat.backCy === gChat.textCy,
     `back=${gChat.backCy} text=${gChat.textCy}`);
  await gCtx.close();
} catch (e) {
  ok("스모크 실행", false, e.message);
} finally {
  if (browser) await browser.close();
  for (const userId of testUserIds) {
    const { error: profileDeleteError } = await admin.from("profiles").delete().eq("id", userId);
    if (profileDeleteError) ok(`정리: profile 삭제 ${userId.slice(0, 8)}`, false, profileDeleteError.message);
    const { error: authDeleteError } = await admin.auth.admin.deleteUser(userId);
    if (authDeleteError) ok(`정리: auth 삭제 ${userId.slice(0, 8)}`, false, authDeleteError.message);
    const { count, error: profileCheckError } = await admin
      .from("profiles").select("id", { count: "exact", head: true }).eq("id", userId);
    ok(`정리: profile 잔존 0 ${userId.slice(0, 8)}`, !profileCheckError && count === 0,
       profileCheckError?.message ?? `count=${count}`);
    const { data: authCheck, error: authCheckError } = await admin.auth.admin.getUserById(userId);
    ok(`정리: auth 잔존 0 ${userId.slice(0, 8)}`,
       authCheckError?.status === 404 && !authCheck?.user,
       authCheckError?.message ?? "user still exists");
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\ngenius avatar UI: PASS=${results.length - failed.length} FAIL=${failed.length}`);
process.exit(failed.length ? 1 : 0);
