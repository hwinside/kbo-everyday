#!/usr/bin/env node
/**
 * 야잘알봇 헤더 진입점 실브라우저 검증 (2026-08-02 하린아빠 지시).
 *
 * 배선 회귀(qa:genius-entry)는 소스 계약만 본다. 여기서는 실제로 렌더되는지,
 * 이미지가 진짜 로드되는지(404여도 <img> 는 DOM 에 남는다), 쪽지 아이콘 왼쪽에
 * 실제 좌표로 있는지, 헤더가 안 깨지는지, 탭하면 어디로 가는지를 본다.
 *
 * 로그인 축은 전용 테스트 계정을 그때그때 만들어 쓰고 끝나면 지운다
 * (AGENTS P0: 하린아빠 개인/공유 계정으로 실사용 QA 금지).
 *
 * 실행: node scripts/qa/genius-entry-browser-smoke.mjs --base-url=http://localhost:3099
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { SUPABASE_URL, ANON, SERVICE_ROLE, REF, BASE } from "./_env.mjs";

const BASE_URL = process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] ?? BASE;
const EXPECT_SRC = "/mascot/yajalal-avatar.png";
const GENIUS_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";

// 헤더 계약: 전역 헤더는 min-h-44px 규격이다. 마스코트를 넣어도 그 규격을 깨면 안 된다.
const HEADER_MIN = 44;
const HEADER_MAX = 64; // 44 + safe-area/패딩 여유. 이걸 넘으면 헤더가 밀린 것.
const MASCOT_MIN_VISIBLE = 32; // 헤더에서 캐릭터가 이보다 작으면 누군지 안 보인다

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function measure(page) {
  return page.evaluate((expectSrc) => {
    const btn = document.querySelector('[data-testid="genius-entry-button"]');
    const dm = document.querySelector('a[href="/messages"]');
    // ⚠️ header 를 btn.closest() 로 찾으면 버튼이 없는 비로그인에서 항상 null 이 되고,
    //    "헤더 없음" 이라는 무관한 FAIL 이 난다(내 첫 하니스가 그랬다).
    //    헤더는 버튼 존재와 무관하게 문서에서 직접 찾는다.
    const header = btn?.closest("header") ?? document.querySelector("header") ?? null;
    const img = btn?.querySelector("img") ?? null;
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    return {
      hasBtn: !!btn,
      hasDm: !!dm,
      btnRect: r(btn),
      dmRect: r(dm),
      headerRect: r(header),
      imgSrc: img?.getAttribute("src") ?? null,
      imgNaturalWidth: img?.naturalWidth ?? 0,
      imgRect: r(img),
      srcMatches: img?.getAttribute("src") === expectSrc,
      docOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  }, EXPECT_SRC);
}

async function main() {
  const browser = await playwright.chromium.launch();
  let testUser = null;

  try {
    // ---------- 비로그인: 진입 자체가 불가능해야 한다 ----------
    // 2026-08-02 하린아빠 "비로그인 상태면 진입 불가능해야돼".
    // 종전 계약은 "버튼 노출 + 탭하면 로그인 시트" 였다. 이제는 버튼이 아예 없어야 한다.
    // 홈(HomeClientShell 자체 헤더)과 뉴스(HeaderProfileLink) 두 헤더 모두 검사한다.
    for (const pg of [
      { label: "홈", path: "/" },
      { label: "뉴스", path: "/news" },
    ]) {
      const T = `[비로그인·${pg.label}]`;
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await page.goto(`${BASE_URL}${pg.path}`, { waitUntil: "networkidle" });

      // AuthContext 가 세션을 확정할 시간을 준다. 확정 전에도 노출되면 안 되지만,
      // 확정 후 뒤늦게 나타나는 회귀를 잡으려면 기다린 뒤에 봐야 한다.
      await page.waitForTimeout(1500);
      const m = await measure(page);

      ok(`${T} 마스코트 진입점이 노출되지 않는다`, !m.hasBtn);
      ok(
        `${T} DOM 에 버튼 자체가 없다(숨김 처리만으로는 불충분)`,
        (await page.locator('[data-testid="genius-entry-button"]').count()) === 0,
      );
      ok(
        `${T} 헤더 높이가 규격 안(진입점 제거로 레이아웃이 깨지지 않음)`,
        !!m.headerRect && m.headerRect.height >= HEADER_MIN && m.headerRect.height <= HEADER_MAX,
        m.headerRect ? `${Math.round(m.headerRect.height)}px` : "(헤더 없음)",
      );
      ok(`${T} 가로 overflow 없음`, !m.docOverflowX);

      await ctx.close();
    }

    // 진입점이 없으니 URL 을 직접 쳐도 대화가 열리면 안 된다(빈 대화 생성 금지).
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await page.goto(`${BASE_URL}/messages/new-${GENIUS_ID}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);
      const body = await page.evaluate(() => document.body.innerText);
      const composerCount = await page.locator("textarea").count();
      ok(
        "[비로그인] 대화방 URL 직접 접근도 입력창을 열어주지 않는다",
        /로그인|카카오|구글/.test(body) || composerCount === 0,
        `composer=${composerCount} url=${page.url()}`,
      );
      await ctx.close();
    }

    // ---------- 로그인 (전용 테스트 계정) ----------
    const email = `qa-genius-entry-${Date.now()}@keubo-qa.invalid`;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      password: `Qa!${Math.random().toString(36).slice(2)}Aa1`,
    });
    if (createErr) throw new Error(`테스트 계정 생성 실패: ${createErr.message}`);
    testUser = created.user;

    // ⚠️ 프로필(닉네임·팀)이 없으면 ProfileSetupWrapper 가 전체화면 모달(z-50)을 띄워
    //    헤더 클릭을 가로챈다. 그건 신규가입 정상 동작이지 이 PR 과 무관하다
    //    (내 첫 하니스가 여기서 30초 타임아웃 나고 구현 결함처럼 보였다).
    //    온보딩을 마친 일반 유저 상태를 만들어 놓고 진입점만 검증한다.
    const { error: profErr } = await admin.from("profiles").upsert(
      { id: testUser.id, nickname: `QA진입${Date.now() % 100000}`, team_id: 1 },
      { onConflict: "id" },
    );
    if (profErr) throw new Error(`테스트 프로필 생성 실패: ${profErr.message}`);

    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkErr) throw new Error(`magiclink 실패: ${linkErr.message}`);

    // hashed_token → redirect fragment 에서 토큰 추출 (POST /verify 는 email/phone 을 요구해 거부한다)
    const vr = await fetch(
      `${SUPABASE_URL}/auth/v1/verify?token=${link.properties.hashed_token}&type=magiclink`,
      { redirect: "manual" },
    );
    const frag = new URLSearchParams((vr.headers.get("location") || "").split("#")[1] || "");
    const accessToken = frag.get("access_token");
    if (!accessToken) throw new Error(`세션 교환 실패: HTTP ${vr.status}`);
    const sessionUser = await (
      await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: ANON, Authorization: `Bearer ${accessToken}` },
      })
    ).json();

    // ⚠️ 앱은 @supabase/ssr createBrowserClient 라 세션을 **쿠키**(base64- 접두)에서 읽는다.
    // localStorage 만 넣으면 AuthContext 가 비로그인으로 보고, 클릭은 로그인 시트를 띄운다
    // — 그럼 하니스 결함이 "라우팅 계약 실패"처럼 보인다(실제로 1차 시도에서 겪음).
    // 쿠키 1개 상한 4096B 때문에 user 객체는 AuthContext 가 쓰는 필드만 남긴다.
    const authKey = `sb-${REF}-auth-token`;
    const slimUser = {
      id: sessionUser.id,
      email: sessionUser.email,
      aud: sessionUser.aud,
      role: sessionUser.role,
      app_metadata: {},
      user_metadata: {},
      created_at: sessionUser.created_at,
    };
    const sessionValue = JSON.stringify({
      access_token: accessToken,
      refresh_token: frag.get("refresh_token"),
      expires_in: 3600,
      expires_at: Number(frag.get("expires_at")),
      token_type: "bearer",
      user: slimUser,
    });

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const u = new URL(BASE_URL);
    const expires = Number(frag.get("expires_at"));
    await ctx.addCookies([
      {
        name: authKey,
        value: `base64-${Buffer.from(sessionValue).toString("base64")}`,
        domain: u.hostname,
        path: "/",
        httpOnly: false,
        secure: u.protocol === "https:",
        sameSite: "Lax",
        ...(Number.isFinite(expires) ? { expires } : {}),
      },
    ]);
    await ctx.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [authKey, sessionValue]);
    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}/news`, { waitUntil: "networkidle" });

    const m2 = await measure(page);
    ok("[로그인] 헤더에 마스코트 버튼이 렌더된다", m2.hasBtn);
    ok(
      "[로그인] 마스코트가 쪽지 아이콘 왼쪽",
      !!m2.btnRect && !!m2.dmRect && m2.btnRect.x < m2.dmRect.x,
    );
    ok(
      "[로그인] 헤더 높이가 규격 안",
      !!m2.headerRect && m2.headerRect.height >= HEADER_MIN && m2.headerRect.height <= HEADER_MAX,
      m2.headerRect ? `${Math.round(m2.headerRect.height)}px` : "",
    );

    // 세션이 실제로 적용됐는지 먼저 확인한다. 미적용이면 클릭은 로그인 시트를 띄우고
    // "라우팅 실패"처럼 보여 진짜 계약을 검증하지 못한다(하니스 결함을 구현 결함으로 오독).
    // 상태 확인은 저장소가 아니라 **앱이 로그인으로 인지하는가**로 본다.
    // 저장소만 보면 토큰이 엉뚱한 자리에 있어도 PASS 라 하니스가 거짓 초록이 된다.
    const authed = await page.evaluate(() => !/카카오로 시작|구글로 시작/.test(document.body.innerText));
    ok("[로그인] 앱이 테스트 세션을 로그인으로 인식", authed);

    // 핵심 계약: 한 탭에 대화창. 신규 유저라 기존 대화가 없으니 초안 방으로 가야 한다.
    await page.click('[data-testid="genius-entry-button"]');
    await page.waitForURL(/\/messages\//, { timeout: 10000 }).catch(() => {});
    const url = page.url();
    if (!url.includes("/messages/")) {
      const diag = await page.evaluate(() => ({
        loginSheet: /카카오|구글|로그인/.test(document.body.innerText),
        bodyHead: document.body.innerText.slice(0, 200),
      }));
      console.log(`  (diag) loginSheet=${diag.loginSheet} body=${JSON.stringify(diag.bodyHead)}`);
    }
    ok(
      "[로그인] 한 탭에 야잘알봇 대화창 진입 (목록 경유 없음)",
      url.includes(`/messages/new-${GENIUS_ID}`),
      url,
    );

    // 진입 즉시 대화 시작이 가능해야 한다 = 입력창이 살아 있어야 한다.
    // composer 는 otherResolved(상대 확정) 뒤에야 렌더된다 — 회신불가 판정 전에
    // 일반 입력창이 깜빡이는 레이스를 막는 의도된 설계다. 그래서 즐시 단정하지 않고
    // 바운드 대기 후 판정한다(안 뜨면 그것대로 FAIL).
    const composerReady = await page
      .waitForSelector("textarea:not([disabled])", { timeout: 8000, state: "visible" })
      .then(() => true)
      .catch(() => false);
    ok("[로그인] 진입 후 입력창 활성 (바로 대화 시작 가능)", composerReady);

    // 입력창이 살아있다고 끝이 아니다 — 예액 입력까지 되는지 확인해야 "대화 시작"이다.
    if (composerReady) {
      await page.fill("textarea", "보크가 뭐야?");
      const typed = await page.inputValue("textarea");
      const sendEnabled = await page.evaluate(() => {
        const btn = document.querySelector('button[aria-label="쪽지 보내기"]');
        return !!btn && !btn.disabled;
      });
      ok("[로그인] 질문 입력·전송버튼 활성", typed === "보크가 뭐야?" && sendEnabled);
    }

    await ctx.close();
  } finally {
    if (testUser?.id) {
      await admin.auth.admin.deleteUser(testUser.id).catch(() => {});
      console.log(`  (cleanup) 테스트 계정 삭제: ${testUser.id}`);
    }
    await browser.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${failed.length === 0 ? "✅" : "❌"} genius entry browser: PASS=${results.length - failed.length} FAIL=${failed.length}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error("SMOKE ERROR:", e.message);
  process.exit(1);
});
