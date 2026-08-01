#!/usr/bin/env node
/**
 * UI 스모크: 커뮤니티 피드 뒤로가기 복원 — **로그인 세션 + 전체문서 back_forward**.
 *
 * 왜 별도 스모크인가(삼순 재리뷰 실측 사고):
 *   익명 SPA 동선은 전부 PASS 인데 **로그인 세션의 전체문서 뒤로가기**만 원 사고가 재현됐다.
 *   scrollY 12972 → 1243, cards 31 → 12.
 *
 *   체인:
 *     1. useUnifiedFeed 초기 effect 가 back_forward 를 1회 소비하고 저장값을 읽는다
 *     2. AuthProvider 는 문서 로드마다 user=null 로 시작한 뒤 세션을 읽어 setUser 한다
 *     3. effect dep 에 user?.id 가 있어 **같은 feed 에서 즉시 재실행**된다
 *     4. 재실행은 1회용 back_forward 를 다시 소비할 수 없어 cameBack=false → 저장값 clear,
 *        첫 복원 load 는 cleanup 으로 취소 → 사고 재현
 *
 *   즉 익명 스모크만으로는 false-green 이다. 이 스모크가 auth hydration(null → user.id)을
 *   실제로 태워서 그 경계를 고정한다.
 *
 * 계정 정책(AGENTS P0): 하린아빠 개인/공유 계정은 절대 쓰지 않는다.
 *   admin API 로 **일회용 전용 테스트 계정**을 만들고 종료 시 반드시 삭제한다.
 *
 * 사용법:
 *     BASE=http://127.0.0.1:3311 node scripts/qa/ui-smoke-feed-scroll-restore-auth.mjs
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { SUPABASE_URL, ANON, SERVICE_ROLE, REF } from "./_env.mjs";

const { chromium } = playwright;
const BASE = process.env.BASE || process.env.QA_BASE_URL || "http://127.0.0.1:3311";
const PATH = process.env.FEED_PATH || "/community/teams/lg";
const TOLERANCE = Number(process.env.TOLERANCE || 250);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const STAMP = Date.now().toString(36);
const email = `qa-feedscroll-${STAMP}@keubo.fan`;
const pw = "QaTest!" + STAMP;

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function signIn() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pw }),
  });
  if (!r.ok) throw new Error(`sign-in failed: ${r.status}`);
  return r.json();
}

/** supabase-ssr 브라우저 클라이언트가 읽는 쿠키 + localStorage 양쪽에 세션을 심는다. */
async function injectSession(ctx, session) {
  const cookieName = `sb-${REF}-auth-token`;
  const tokenObj = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    token_type: "bearer",
    user: session.user,
  };
  const ls = JSON.stringify(tokenObj);
  await ctx.addCookies([
    {
      name: cookieName,
      value: `base64-${Buffer.from(ls).toString("base64")}`,
      domain: new URL(BASE).hostname,
      path: "/",
      httpOnly: false,
      secure: BASE.startsWith("https"),
      sameSite: "Lax",
      expires: session.expires_at,
    },
  ]);
  await ctx.addInitScript(
    ([k, v]) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {}
    },
    [cookieName, ls],
  );
}

let userId = null;
let browser = null;

try {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: pw,
    email_confirm: true,
  });
  if (error) throw error;
  userId = created.user.id;
  const { error: pErr } = await admin
    .from("profiles")
    .insert({ id: userId, nickname: `qa${STAMP}`.slice(0, 14), team_id: 2002 });
  if (pErr) throw new Error("profile insert failed: " + pErr.message);
  const session = await signIn();
  console.log(`전용 테스트 계정 생성: ${userId.slice(0, 8)}…`);

  // ⚠️ BFCache 로 복귀하면 문서가 통째로 살아 돌아와 우리 코드가 아예 안 돈다 → 경계를 못 본다.
  // 삼순 재현 조건과 동일하게 BFCache 를 끄고, 뒤로가기가 **전체문서 로드**가 되게 한다.
  browser = await chromium.launch({
    args: ["--disable-features=BackForwardCache"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  await injectSession(ctx, session);
  const page = await ctx.newPage();

  const cardCount = () =>
    page.evaluate(() => document.querySelectorAll('a[href^="/community/free/"]').length);
  const authUid = () =>
    page.evaluate(() => {
      try {
        return window.localStorage.getItem("kbo-auth-uid");
      } catch {
        return null;
      }
    });
  const navType = () =>
    page.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0];
      return n ? n.type : null;
    });

  console.log("\n[로그인 세션 · 전체문서 back_forward]");
  await page.goto(BASE + PATH, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4500);
  // auth hydration 이 실제로 일어났는지 확인 — 이게 없으면 이 스모크는 익명 스모크와 같다.
  const uidBefore = await authUid();
  check("auth hydration 발생(로그인 세션 인식)", uidBefore === userId, `uid=${String(uidBefore).slice(0, 8)}`);

  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(1100);
  }
  const beforeY = await page.evaluate(() => window.scrollY);
  const beforeCards = await cardCount();
  console.log(`  [진입 전] scrollY=${beforeY} cards=${beforeCards}`);
  check("전제: 깊은 스크롤 확보", beforeY > 3000 && beforeCards > 20, `y=${beforeY} cards=${beforeCards}`);

  // 복원 목표 = 떠나기 직전의 실제 위치.
  const targetY = await page.evaluate(() => window.scrollY);
  const detailHref = await page.locator('a[href^="/community/free/"]').nth(12).getAttribute("href");
  check("진입할 글 링크 확보", !!detailHref, detailHref || "none");

  // ⚠️ 여기서 link.click() 을 쓰면 SPA 라우팅이라 뒤로가기가 popstate 경로로 처리된다.
  // 삼순이 잡은 사고는 **전체문서 back_forward** 경로이므로 문서 전체 이동으로 진입해야 한다
  // (모바일 웹뷰/새로고침 뒤 뒤로가기가 실제로 이렇게 동작한다).
  await page.goto(BASE + detailHref, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  check("글 상세 진입(전체문서)", page.url().includes("/community/free/"), page.url());

  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6500);

  const nt = await navType();
  const uidAfter = await authUid();
  const afterY = await page.evaluate(() => window.scrollY);
  const afterCards = await cardCount();
  console.log(`  [복귀 후] scrollY=${afterY} cards=${afterCards} navType=${nt} uid=${String(uidAfter).slice(0, 8)}`);

  check("전제: 전체문서 back_forward 로 복귀(BFCache 아님)", nt === "back_forward", `navType=${nt}`);
  check("전제: 복귀 후에도 로그인 세션 유지(auth hydration 재실행 경로)", uidAfter === userId);
  check("로드 분량(카드 수) 복원", afterCards >= beforeCards, `${beforeCards} → ${afterCards}`);
  check(
    `스크롤 위치 복원(±${TOLERANCE}px)`,
    Math.abs(afterY - targetY) <= TOLERANCE,
    `${targetY} → ${afterY} (Δ${Math.abs(afterY - targetY)})`,
  );
} catch (e) {
  failures++;
  console.error("ERROR", e.message);
} finally {
  if (browser) await browser.close();
  // 전용 테스트 계정은 반드시 정리한다 (AGENTS P0).
  //
  // ⚠️ 예전 코드는 두 delete 의 반환 `{ error }` 를 검사하지 않고 무조건
  // "정리 완료" 를 출력했다. Supabase 는 삭제 실패를 보통 throw 가 아니라
  // resolved `{ error }` 로 돌려주므로 계정이 남아도 exit 0 이었다(삼순 3차 NO-GO).
  // 또 profile 삭제가 throw 하면 auth user 삭제 시도 자체를 건너뛰었다.
  //
  // 계약: (1) 둘을 서로 독립적으로 끝까지 시도 (2) 각 반환 error 검사
  //       (3) 삭제 후 profile 0 + auth user not-found postcondition
  //       (4) 하나라도 실패/잔존이면 failures++ → exit 1
  if (userId) {
    const cleanupProblems = [];

    // (1)(2) 독립 시도 + 반환 error 검사. 앞이 실패해도 뒤는 반드시 시도한다.
    try {
      const { error } = await admin.from("profiles").delete().eq("id", userId);
      if (error) cleanupProblems.push(`profile delete error: ${error.message}`);
    } catch (e) {
      cleanupProblems.push(`profile delete threw: ${e.message}`);
    }
    try {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) cleanupProblems.push(`auth delete error: ${error.message}`);
    } catch (e) {
      cleanupProblems.push(`auth delete threw: ${e.message}`);
    }

    // (3) postcondition — "삭제 호출이 성공했다" 가 아니라 "실제로 없다" 를 본다.
    try {
      const { count, error } = await admin
        .from("profiles").select("id", { count: "exact", head: true }).eq("id", userId);
      if (error) cleanupProblems.push(`profile postcondition 조회 실패: ${error.message}`);
      else if ((count ?? 0) !== 0) cleanupProblems.push(`profile 잔존 ${count}건`);
    } catch (e) {
      cleanupProblems.push(`profile postcondition threw: ${e.message}`);
    }
    try {
      const { data, error } = await admin.auth.admin.getUserById(userId);
      // not-found 는 정상(우리가 지운 것). 그 외 에러는 확인 불가라 실패로 본다.
      if (data?.user) cleanupProblems.push(`auth user 잔존: ${userId}`);
      else if (error && !/not.?found/i.test(error.message)) {
        cleanupProblems.push(`auth postcondition 확인 불가: ${error.message}`);
      }
    } catch (e) {
      cleanupProblems.push(`auth postcondition threw: ${e.message}`);
    }

    // (4) 실패/잔존이면 스모크 전체를 실패로 종결한다.
    if (cleanupProblems.length > 0) {
      failures += 1;
      console.error(`FAIL 전용 테스트 계정 정리 (${userId})`);
      for (const problem of cleanupProblems) console.error("  -", problem);
    } else {
      console.log(`전용 테스트 계정 정리 완료 (auth·profiles 잔존 0 확인) ${userId}`);
    }
  }
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} (failures=${failures})`);
process.exit(failures === 0 ? 0 : 1);
