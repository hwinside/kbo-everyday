#!/usr/bin/env node
/**
 * 야잘알봇 홈 헤더 진입점 실브라우저 검증
 * (2026-08-03 미노출 계약 → 2026-08-21 하린아빠 "홈에 야잘알봇 꺼내기"로 재노출).
 *
 * 새 계약:
 *  · 비로그인 → 어느 헤더에도 미노출 (2026-08-02 "비로그인 진입 불가" 유지)
 *  · 로그인·홈 → 쪽지 아이콘 왼쪽에 노출, 스윙/투구 모션 WebP 중 하나, 탭하면 대화창 직행
 *  · 로그인·뉴스(HeaderProfileLink) → 미노출 유지 (지시 범위는 홈)
 *  · 쪽지함 목록 → 야잘알봇 카드 없음 (2026-08-21 "기본 쪽지함에서 야잘알봇 대화창 제거")
 *
 * 배선 회귀(qa:genius-entry)는 소스 계약만 본다. 여기서는 실제 렌더/클릭을 본다.
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
// 진입점은 스윙/투구 모션 WebP 중 하나를 랜덤 노출한다 (2026-08-21 지시).
const MOTION_SRC_RE = /^\/mascot\/motion\/(swing|pitching)\.webp$/;
const GENIUS_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
const PAGES = [
  { label: "홈", path: "/" },
  { label: "뉴스", path: "/news" },
];

// 헤더 계약: 전역 헤더는 min-h-44px 규격이다. 진입점을 빼도 그 규격을 깨면 안 된다.
const HEADER_MIN = 44;
const HEADER_MAX = 64; // 44 + safe-area/패딩 여유. 이걸 넘으면 헤더가 밀린 것.

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
    const sibling = btn?.parentElement
      ? [...btn.parentElement.children].find((element) => element !== btn) ?? null
      : null;
    const anchor = dm ?? sibling;
    const img = btn?.querySelector("img") ?? null;
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    return {
      hasBtn: !!btn,
      hasDm: !!dm,
      btnRect: r(btn),
      dmRect: r(dm),
      anchorRect: r(anchor),
      headerRect: r(header),
      imgSrc: img?.getAttribute("src") ?? null,
      imgNaturalWidth: img?.naturalWidth ?? 0,
      imgRect: r(img),
      srcMatches: expectSrc ? new RegExp(expectSrc).test(img?.getAttribute("src") ?? "") : false,
      docOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  }, MOTION_SRC_RE.source);
}

async function main() {
  const browser = await playwright.chromium.launch();
  let testUser = null;
  let buddyUser = null;
  const qaConvIds = [];

  try {
    // ---------- 비로그인: 진입 자체가 불가능해야 한다 ----------
    // 2026-08-02 하린아빠 "비로그인 상태면 진입 불가능해야돼".
    // 종전 계약은 "버튼 노출 + 탭하면 로그인 시트" 였다. 이제는 버튼이 아예 없어야 한다.
    // 홈(HomeClientShell 자체 헤더)과 뉴스(HeaderProfileLink) 두 헤더 모두 검사한다.
    for (const pg of PAGES) {
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
      const composerCount = await page.locator("textarea").count();
      ok(
        "[비로그인] 대화방 URL 직접 접근은 /messages로 이탈한다",
        new URL(page.url()).pathname === "/messages" && composerCount === 0,
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
    // 홈: 버튼 노출 + 모션 자산 + 쪽지 아이콘 왼쪽 (2026-08-21 지시)
    {
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500); // AuthContext 세션 확정 대기
      const measured = await measure(page);
      ok("[로그인·홈] 헤더에 마스코트 버튼 노출", measured.hasBtn);
      ok(
        "[로그인·홈] 스윙/투구 모션 WebP 중 하나를 렌더",
        measured.srcMatches,
        `src=${measured.imgSrc}`,
      );
      ok(
        "[로그인·홈] 모션 자산 실제 로드됨(404 아님)",
        measured.imgNaturalWidth > 0,
        `naturalWidth=${measured.imgNaturalWidth}`,
      );
      ok(
        "[로그인·홈] 버튼이 쪽지 아이콘 왼쪽",
        !!measured.btnRect && !!measured.dmRect && measured.btnRect.x < measured.dmRect.x,
        measured.btnRect && measured.dmRect ? `btn.x=${Math.round(measured.btnRect.x)} dm.x=${Math.round(measured.dmRect.x)}` : "",
      );
      ok(
        "[로그인·홈] 헤더 높이 규격(진입점 추가로 레이아웃 안 깨짐)",
        !!measured.headerRect && measured.headerRect.height >= HEADER_MIN && measured.headerRect.height <= HEADER_MAX,
        measured.headerRect ? `${Math.round(measured.headerRect.height)}px` : "",
      );
      ok("[로그인·홈] 가로 overflow 없음", !measured.docOverflowX);

      // 탭하면 대화창 직행 (목록 경유 금지)
      await page.click('[data-testid="genius-entry-button"]');
      await page.waitForURL(/\/messages\/(new-)?[0-9a-f-]+/, { timeout: 8000 });
      const clickUrl = new URL(page.url()).pathname;
      ok(
        "[로그인·홈] 탭 → 야잘알봇 대화창 직행(목록 경유 안 함)",
        clickUrl.startsWith("/messages/") && clickUrl !== "/messages",
        clickUrl,
      );
    }

    // edge-click 회귀 (삼순 NO-GO ①): 마스코트 overflow(폭 ~56px)가 쪽지 버튼 위에
    // 그려져도 탭 판정은 44px 버튼만 해야 한다. 쪽지 버튼 왼쪽 가장자리(overflow 겁침
    // 영역)를 클릭하면 야잘알봇이 아니라 쪽지 목록으로 가야 한다.
    {
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      const m = await measure(page);
      if (!m.dmRect) {
        ok("[로그인·홈] edge-click 회귀: 쪽지 버튼 좌표 확보", false, "dmRect 없음");
      } else {
        // 쪽지 버튼 왼쪽 가장자리 안쪽 2px — 마스코트 overflow 가 겁치는 지점이다.
        await page.mouse.click(m.dmRect.x + 2, m.dmRect.y + m.dmRect.height / 2);
        await page.waitForTimeout(2500);
        const edgePath = new URL(page.url()).pathname;
        ok(
          "[로그인·홈] 쪽지 버튼 왼쪽 가장자리 탭 → 쪽지 목록(마스코트 overflow 가 탭을 안 먹음)",
          edgePath === "/messages",
          `path=${edgePath} clickX=${Math.round(m.dmRect.x + 2)}`,
        );
      }
    }

    // 배지 동작 검증 (삼순 NO-GO ②): 봇 unread 는 배지에서 제외, 일반 unread 는 유지.
    // service-role 로 봇방 unread 1건 + 일반방 unread 1건을 만들고 홈 배지가 1인지 본다.
    {
      const { data: buddy, error: buddyErr } = await admin.auth.admin.createUser({
        email: `qa-genius-buddy-${Date.now()}@keubo-qa.invalid`,
        email_confirm: true,
        password: `Qa!${Math.random().toString(36).slice(2)}Bb2`,
      });
      if (buddyErr) throw new Error(`buddy 계정 생성 실패: ${buddyErr.message}`);
      buddyUser = buddy.user;
      const { error: buddyProfErr } = await admin.from("profiles").upsert(
        { id: buddyUser.id, nickname: `QA버디${Date.now() % 100000}`, team_id: 2 },
        { onConflict: "id" },
      );
      if (buddyProfErr) throw new Error(`buddy 프로필 생성 실패: ${buddyProfErr.message}`);

      const mkConv = async (a, b, lastMessage) => {
        const [u1, u2] = [a, b].sort();
        const { data: conv, error } = await admin
          .from("dm_conversations")
          .insert({ user1_id: u1, user2_id: u2, last_message: lastMessage, last_message_at: new Date().toISOString() })
          .select("id")
          .single();
        if (error) throw new Error(`conv 생성 실패: ${error.message}`);
        qaConvIds.push(conv.id);
        return conv.id;
      };
      // ⚠️ 절대값(=1) 판정은 하니스 결함이었다 — 홈 진입 시 useHomeInit 이 운영팀
      // 웰컴 쪽지(/api/welcome-dm)를 보내 신규 QA 계정 배지에 +1 이 섞인다.
      // 그래서 **baseline 대비 delta** 로 판정한다: 봇 unread 1 + 일반 unread 1 을
      // 넣었을 때 delta 가 정확히 +1(일반만)이면 봇 제외·일반 유지 둘 다 증명된다.
      // 봇이 세지면 +2, 일반까지 새면 +0 이라 양방향 모두 걸린다.
      const readBadge = async () => {
        await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
        await page.waitForTimeout(2500); // 배지 load + realtime 안정화
        return page.evaluate(() => {
          const dm = document.querySelector('header a[href="/messages"]');
          const span = dm?.querySelector("span");
          const text = span ? span.textContent.trim() : null;
          return text === null ? 0 : text === "9+" ? 10 : Number(text);
        });
      };
      const baseline = await readBadge();

      const geniusConv = await mkConv(testUser.id, GENIUS_ID, "[QA] 봇 unread");
      const buddyConv = await mkConv(testUser.id, buddyUser.id, "[QA] 일반 unread");
      const { error: msgErr } = await admin.from("dm_messages").insert([
        { conversation_id: geniusConv, sender_id: GENIUS_ID, content: "[QA] 봇 unread", is_read: false },
        { conversation_id: buddyConv, sender_id: buddyUser.id, content: "[QA] 일반 unread", is_read: false },
      ]);
      if (msgErr) throw new Error(`unread 메시지 생성 실패: ${msgErr.message}`);

      const after = await readBadge();
      ok(
        "[로그인·배지] 봇 unread 제외·일반 unread 유지 — delta 정확히 +1",
        after - baseline === 1,
        `baseline=${baseline} after=${after} (봇이 세면 +2, 일반까지 빠지면 +0)`,
      );
    }

    // 뉴스(HeaderProfileLink 헤더): 미노출 유지 — 지시 범위는 홈이다.
    {
      await page.goto(`${BASE_URL}/news`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);
      const measured = await measure(page);
      ok("[로그인·뉴스] 헤더에 마스코트 버튼 미노출(홈 한정 지시)", !measured.hasBtn);
      ok(
        "[로그인·뉴스] 헤더 높이 규격",
        !!measured.headerRect && measured.headerRect.height >= HEADER_MIN && measured.headerRect.height <= HEADER_MAX,
      );
    }

    // 쪽지함 목록: 야잘알봇 카드가 없어야 한다 (2026-08-21 지시)
    {
      await page.goto(`${BASE_URL}/messages`, { waitUntil: "networkidle" });
      await page.waitForTimeout(2000); // 목록 로드 대기
      const inbox = await page.evaluate(() => ({
        hasGeniusCard: document.body.innerText.includes("야잘알봇"),
        hasMascotImg: !!document.querySelector('img[src*="/mascot/"]'),
      }));
      ok("[로그인·쪽지함] 야잘알봇 카드 미노출", !inbox.hasGeniusCard && !inbox.hasMascotImg,
         `text=${inbox.hasGeniusCard} img=${inbox.hasMascotImg}`);
    }

    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

    // 세션이 실제로 적용됐는지 먼저 확인한다. 미적용이면 클릭은 로그인 시트를 띄우고
    // "라우팅 실패"처럼 보여 진짜 계약을 검증하지 못한다(하니스 결함을 구현 결함으로 오독).
    // 상태 확인은 저장소가 아니라 **앱이 로그인으로 인지하는가**로 본다.
    // 저장소만 보면 토큰이 엉뚱한 자리에 있어도 PASS 라 하니스가 거짓 초록이 된다.
    const authed = await page.evaluate(() => !/카카오로 시작|구글로 시작/.test(document.body.innerText));
    ok("[로그인] 앱이 테스트 세션을 로그인으로 인식", authed);

    // 헤더만 숨기는 핫픽스이므로 로그인 사용자의 직접 대화 URL은 계속 동작해야 한다.
    await page.goto(`${BASE_URL}/messages/new-${GENIUS_ID}`, { waitUntil: "networkidle" });
    const url = page.url();
    if (!url.includes("/messages/")) {
      const diag = await page.evaluate(() => ({
        loginSheet: /카카오|구글|로그인/.test(document.body.innerText),
        bodyHead: document.body.innerText.slice(0, 200),
      }));
      console.log(`  (diag) loginSheet=${diag.loginSheet} body=${JSON.stringify(diag.bodyHead)}`);
    }
    ok(
      "[로그인] 직접 URL로 야잘알봇 대화창 진입",
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
    // QA 대화/메시지 정리 — 유저 삭제보다 먼저(FK). 삭제 실패는 예외로 드러낸다(fail-open 금지).
    for (const convId of qaConvIds) {
      const { error: msgDelErr } = await admin.from("dm_messages").delete().eq("conversation_id", convId);
      if (msgDelErr) throw new Error(`dm_messages cleanup: ${msgDelErr.message}`);
      const { error: convDelErr } = await admin.from("dm_conversations").delete().eq("id", convId);
      if (convDelErr) throw new Error(`dm_conversations cleanup: ${convDelErr.message}`);
      const { count: convLeft, error: convChkErr } = await admin
        .from("dm_conversations").select("id", { count: "exact", head: true }).eq("id", convId);
      if (convChkErr || convLeft !== 0) throw new Error(`conv cleanup postcondition: ${convChkErr?.message ?? convLeft}`);
    }
    if (buddyUser?.id) {
      const { error: buddyProfDelErr } = await admin.from("profiles").delete().eq("id", buddyUser.id);
      if (buddyProfDelErr) throw new Error(`buddy profile cleanup: ${buddyProfDelErr.message}`);
      const { error: buddyAuthDelErr } = await admin.auth.admin.deleteUser(buddyUser.id);
      if (buddyAuthDelErr) throw new Error(`buddy auth cleanup: ${buddyAuthDelErr.message}`);
    }
    if (testUser?.id) {
      const { error: profileDeleteError } = await admin.from("profiles").delete().eq("id", testUser.id);
      if (profileDeleteError) throw new Error(`profile cleanup: ${profileDeleteError.message}`);
      const { error: authDeleteError } = await admin.auth.admin.deleteUser(testUser.id);
      if (authDeleteError) throw new Error(`auth cleanup: ${authDeleteError.message}`);
      const { count, error: profileCheckError } = await admin
        .from("profiles").select("id", { count: "exact", head: true }).eq("id", testUser.id);
      if (profileCheckError || count !== 0) throw new Error(`profile cleanup postcondition: ${profileCheckError?.message ?? count}`);
      const { data: authCheck, error: authCheckError } = await admin.auth.admin.getUserById(testUser.id);
      if (authCheckError?.status !== 404 || authCheck?.user) {
        throw new Error(`auth cleanup postcondition: ${authCheckError?.message ?? "user remains"}`);
      }
      console.log(`  (cleanup) 테스트 계정 삭제·잔존 0: ${testUser.id}`);
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
