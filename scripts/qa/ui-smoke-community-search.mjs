#!/usr/bin/env node
/**
 * UI 스모크: 커뮤니티 검색 v1 (전체글 탭) — End-User Level (Playwright 실브라우저, 전용 테스트 계정 2개).
 *
 * 고정하는 계약(삼순 계획 리뷰 ④ + 정정 ①):
 *  1. 일반/검색 피드 2페이지 → 화면 안 작성자 프로필 → 뒤로가기: URL·분량·스크롤 복원.
 *  2. 타이핑 → 300ms 디바운스 → RPC `search_posts` 요청 1회. 1자만 입력하면 요청 0회 + 안내 문구.
 *  3. iOS/안드 한글 IME: 조합 중(compositionstart~end) 요청 0회, 조합 종료 후 1회.
 *  4. 빠른 재입력 race: 앞 검색어 응답이 늦게 도착해도 화면은 뒤 검색어 결과(이전 응답 폐기).
 *  5. 2계정 차단: A 가 B 차단 → A 의 검색 결과에 B 글 없음, B 본인은 자기 글을 본다.
 *  6. 무결과 검색어 → 빈 결과 문구.
 *
 * 계정 정책(AGENTS P0): 하린아빠 개인/공유 계정 사용 금지. admin API 로 일회용 계정을 만들고 종료 시 삭제한다.
 * 전제: 대상 DB 에 migration(search_posts) 적용 완료. 앱 서버: BASE(기본 http://127.0.0.1:3311).
 *
 *   BASE=http://127.0.0.1:3311 node scripts/qa/ui-smoke-community-search.mjs
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { SUPABASE_URL, ANON, SERVICE_ROLE, REF } from "./_env.mjs";

const { chromium } = playwright;
const BASE = process.env.BASE || process.env.QA_BASE_URL || "http://127.0.0.1:3311";
const FEED = "/community/all-posts";
const RPC_RE = /\/rest\/v1\/rpc\/search_posts/;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const STAMP = Date.now().toString(36);
const TOKEN = `큐에이검색${STAMP}`; // 운영 글과 절대 겹치지 않는 검색어(한글+스탬프)
const pw = "QaTest!" + STAMP;
const emailA = `qa-search-a-${STAMP}@keubo.fan`;
const emailB = `qa-search-b-${STAMP}@keubo.fan`;

let failures = 0;
const cleanupUsers = [];
const cleanupPosts = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(email) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pw }),
  });
  if (!r.ok) throw new Error(`sign-in failed: ${r.status}`);
  return r.json();
}

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

async function seed() {
  const users = {};
  for (const [k, email] of [["A", emailA], ["B", emailB]]) {
    const { data, error } = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
    if (error) throw error;
    cleanupUsers.push(data.user.id);
    const { error: pErr } = await admin
      .from("profiles")
      .insert({ id: data.user.id, nickname: `qa검색${k}${STAMP.slice(-4)}`, team_id: 2002 });
    if (pErr) throw new Error("profile insert failed: " + pErr.message);
    users[k] = data.user;
  }
  // A: 제목 매치 1건. B: 제목 매치 1건 + 본문 매치 1건.
  // team_tags / player_tags 는 posts 테이블의 필수 JSONB 컬럼 — team_tags 는 canonical KBO 구단 slug 1개 이상 필수(posts_require_team_scope) — 배열 길이 아닌 canonical slug 존재 판정이라 빈 배열 []도 거부된다. 그래서 시드는 ['lg']로 태그한다(삼순 NO-GO ②).
  const rows = [
    { author_id: users.A.id, board_type: "free", board_id: "general", title: `${TOKEN} A 제목`, content: "본문 A", team_tags: ["lg"], player_tags: [] },
    { author_id: users.B.id, board_type: "free", board_id: "general", title: `${TOKEN} B 제목`, content: "본문 B", team_tags: ["lg"], player_tags: [] },
    { author_id: users.B.id, board_type: "free", board_id: "general", title: "B 두번째 글", content: `본문에 ${TOKEN} 포함`, team_tags: ["lg"], player_tags: [] },
  ];
  const { data: posts, error } = await admin.from("posts").insert(rows).select("id, author_id, title");
  if (error) throw new Error("post insert failed: " + error.message);
  cleanupPosts.push(...posts.map((p) => p.id));

  // 페이지네이션 테스트용 추가 글 — TOKEN 이 있어야 검색에서 나온다(pageSize=20 초과).
  const extra = Array.from({ length: 18 }, (_, i) => ({
    author_id: users.A.id, board_type: "free", board_id: "general",
    title: `${TOKEN} 추가${i + 1}`, content: "본문", team_tags: ["lg"], player_tags: [],
  }));
  const { data: extraPosts, error: eErr } = await admin.from("posts").insert(extra).select("id");
  if (eErr) throw new Error("extra post insert failed: " + eErr.message);
  cleanupPosts.push(...extraPosts.map((p) => p.id));

  return { users, posts };
}

/** 카드 목록에서 TOKEN 이 보이는 개수(제목 또는 본문 렌더 텍스트 기준). */
async function visibleTokenCount(page) {
  return page.evaluate((tok) => {
    const text = document.body.innerText || "";
    // 검색 입력창 자체의 값은 innerText 에 안 들어가지만 안내 문구('‘tok’ 검색 결과…')는 들어갈 수 있어 제외
    const cleaned = text.replace(new RegExp(`‘${tok}’`, "g"), "");
    return (cleaned.match(new RegExp(tok, "g")) || []).length;
  }, TOKEN);
}

function trackRpc(page) {
  const calls = [];
  page.on("request", (req) => {
    if (RPC_RE.test(req.url())) {
      let q = null;
      try {
        q = JSON.parse(req.postData() || "{}").q ?? null;
      } catch {}
      calls.push({ q, t: Date.now() });
    }
  });
  return calls;
}

async function waitRpcSettled(page) {
  // RPC 응답 + 렌더 여유
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(300);
}

/** 실제 뷰포트 안 프로필 링크를 좌표 클릭한다. locator.click의 자동 최상단 스크롤을 허용하지 않는다. */
async function openViewportProfile(page) {
  const target = await page.locator('a[href^="/profile/"]').evaluateAll((anchors) => {
    const candidates = anchors.flatMap((anchor) => {
      const rect = anchor.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      // 고정 헤더/탭바를 피해 실제 클릭 가능한 링크만 고른다.
      if (rect.width <= 0 || rect.height <= 0 || x <= 0 || x >= window.innerWidth || y <= 120 || y >= window.innerHeight - 120) return [];
      const hit = document.elementFromPoint(x, y);
      if (!hit || !anchor.contains(hit)) return [];
      return [{ x, y, href: anchor.getAttribute("href"), distance: Math.abs(y - window.innerHeight / 2) }];
    });
    return candidates.sort((a, b) => a.distance - b.distance)[0] ?? null;
  });
  if (!target) throw new Error("현재 뷰포트에 클릭 가능한 작성자 프로필 링크가 없음");
  const beforeScroll = await page.evaluate(() => window.scrollY);
  await Promise.all([
    page.waitForURL((u) => u.pathname === target.href, { timeout: 15000 }),
    page.mouse.click(target.x, target.y),
  ]);
  return beforeScroll;
}

(async () => {
  let browser;
  try {
    console.log(`[qa] base=${BASE} token=${TOKEN}`);
    const { users, posts } = await seed();
    browser = await chromium.launch();

    // ───────── 1. 일반/검색 피드 → 프로필 → 뒤로가기 (익명) ─────────
    // 텍스트 카드 탭은 댓글 시트다. 없는 '텍스트 글 상세 <a>' 대신 두 피드 모두 실제
    // 작성자 프로필로 이탈해 라우트 복귀를 검증한다(삼식 P0 일반 피드 회귀 포함).
    for (const query of [null, TOKEN]) {
      const mode = query === null ? "일반 피드" : "검색 피드";
      console.log(`1. ${mode} 2페이지 → 프로필 → 뒤로가기`);
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      const calls = trackRpc(page);
      await page.goto(`${BASE}${FEED}${query ? `?q=${encodeURIComponent(query)}` : ""}`, { waitUntil: "networkidle" });
      await waitRpcSettled(page);
      check(`${mode}: 입력창 q`, (await page.getByTestId("post-search-input").inputValue()) === (query ?? ""));
      const n1 = await visibleTokenCount(page);
      check(`${mode}: 1페이지 시드 결과 노출`, n1 >= 20, `visible=${n1}`);
      check(`${mode}: 초기 검색 RPC ${query ? 1 : 0}회`, calls.length === (query ? 1 : 0), `calls=${calls.length}`);

      // 복원 판별력: 프로필로 떠나기 전 2페이지까지 로드해 둔다(시드 21건). 그래야 뒤로가기
      // 복원이 '1페이지·최상단으로 퇴화'해도 통과하지 않는다. 검색은 id desc 라 2페이지에만 있는 글은
      // 최고령 시드 "TOKEN A 제목"(id 최소) — 복원 후에도 이 글과 스크롤 위치가 살아있으면 분량이 복원된 것.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForFunction((t) => (document.body.innerText || "").includes(t), `${TOKEN} A 제목`, { timeout: 15000 });
      const beforeCount = await visibleTokenCount(page);
      // 자동 스크롤 없는 실제 좌표 클릭: 첫 카드 클릭으로 진짜 scrollY=0을 만들어
      // 복원 상태를 지워버리는 테스트 결함을 막는다.
      const beforeScroll = await openViewportProfile(page);
      check(`${mode}: 떠나기 전 2페이지 로드(시드 21건)`, beforeCount >= 21 && beforeScroll > 0, `count=${beforeCount} scrollY=${beforeScroll}`);
      check(`${mode}: 작성자 프로필 진입`, true, new URL(page.url()).pathname);
      await page.goBack({ waitUntil: "networkidle" });
      await waitRpcSettled(page);
      // 복원(분량·스크롤)이 적용될 때까지 기다린다. 회귀(정상)면 빨리 충족, 퇴화(버그)면 타임아웃 후 검사 실패.
      await page.waitForFunction((t) => (document.body.innerText || "").includes(t), `${TOKEN} A 제목`, { timeout: 10000 }).catch(() => {});
      const tolerance = Math.max(100, beforeScroll * 0.15);
      await page.waitForFunction(({ before, tolerance }) => Math.abs(window.scrollY - before) <= tolerance, { before: beforeScroll, tolerance }, { timeout: 10000 }).catch(() => {});
      const u = new URL(page.url());
      const afterText = await page.evaluate(() => document.body.innerText || "");
      const afterCount = await visibleTokenCount(page);
      const afterScroll = await page.evaluate(() => window.scrollY);
      check(`${mode}: 뒤로가기 후 URL 유지`, u.pathname === FEED && u.searchParams.get("q") === query, u.search);
      check(`${mode}: 뒤로가기 후 2페이지 분량 복원`, afterText.includes(`${TOKEN} A 제목`) && afterCount >= beforeCount, `before=${beforeCount} after=${afterCount}`);
      check(`${mode}: 뒤로가기 후 스크롤 위치 복원`, Math.abs(afterScroll - beforeScroll) <= tolerance, `before=${beforeScroll} after=${afterScroll} tolerance=${tolerance}`);
      check(`${mode}: 뒤로가기 후 입력창 값 유지`, (await page.getByTestId("post-search-input").inputValue()) === (query ?? ""));
      await ctx.close();
    }

    // ───────── 2. 타이핑 디바운스 + 1자 가드 ─────────
    {
      console.log("2. 타이핑 디바운스 / 1자 가드");
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      const calls = trackRpc(page);
      await page.goto(`${BASE}${FEED}`, { waitUntil: "networkidle" });
      const input = page.getByTestId("post-search-input");
      await input.fill("큐");
      await sleep(700);
      check("1자 입력: RPC 0회", calls.length === 0, `calls=${calls.length}`);
      check("1자 입력: 안내 문구", await page.getByTestId("post-search-hint").isVisible());
      await input.fill(""); // 지우기
      await input.pressSequentially(TOKEN, { delay: 20 }); // 글자 간 20ms < 300ms 디바운스
      await sleep(900);
      await waitRpcSettled(page);
      const forToken = calls.filter((c) => c.q === TOKEN).length;
      check("연속 타이핑: 최종 검색어 RPC 정확히 1회", forToken === 1 && calls.length === 1, `calls=${JSON.stringify(calls.map((c) => c.q))}`);
      check("URL ?q= 동기화", new URL(page.url()).searchParams.get("q") === TOKEN);
      check("결과 노출", (await visibleTokenCount(page)) >= 3);
      await page.getByTestId("post-search-clear").click();
      await waitRpcSettled(page);
      check("지우기 → ?q 제거 + 일반 피드", !new URL(page.url()).searchParams.has("q") && !(await page.getByTestId("post-search-empty").isVisible().catch(() => false)));
      await ctx.close();
    }

    // ───────── 3. 한글 IME 조합 ─────────
    {
      console.log("3. 한글 IME 조합 중 요청 없음");
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      const calls = trackRpc(page);
      await page.goto(`${BASE}${FEED}`, { waitUntil: "networkidle" });
      const input = page.getByTestId("post-search-input");
      await input.focus();

      // [1단계] compositionstart + 조합 중 입력만 (compositionend 없음).
      // compositionstart 가 디바운스 타이머를 취소해야 함을 검증한다.
      // 300ms 이상 기다려도 RPC 가 안 나가야 정상 — 순수 디바운스 구현이면 여기서 요청이 나간다(버그 포착).
      await page.evaluate(() => {
          const el = document.querySelector('[data-testid="post-search-input"]');
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          const fire = (type, init) => el.dispatchEvent(new (type.startsWith("composition") ? CompositionEvent : InputEvent)(type, { bubbles: true, ...init }));
          fire("compositionstart", {});
          const partials = ["ㅋ", "큐", "큐ㅇ", "큐에", "큐에ㅇ", "큐에이"];
          for (const p of partials) {
            setter.call(el, p);
            fire("input", { isComposing: true, inputType: "insertCompositionText", data: p });
          }
        });
      await sleep(400); // 300ms 디바운스를 충분히 초과 — 타이머가 살아있었다면 이미 발화
      check("조합 중(compositionstart 후 400ms) RPC 0회 — 타이머 취소 확인", calls.length === 0, `calls=${calls.length}`);

      // [2단계] compositionend 발화 → 디바운스 예약 → 300ms 후 RPC 1회
      await page.evaluate(
        ([tok]) => {
          const el = document.querySelector('[data-testid="post-search-input"]');
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          const fire = (type, init) => el.dispatchEvent(new (type.startsWith("composition") ? CompositionEvent : InputEvent)(type, { bubbles: true, ...init }));
          setter.call(el, tok);
          fire("compositionend", { data: tok });
          fire("input", { isComposing: false, inputType: "insertText", data: tok });
        },
        [TOKEN],
      );
      await sleep(500); // compositionend 후 디바운스(300ms) 통과 여유
      await waitRpcSettled(page);
      check("조합 종료 후 RPC 1회(최종 검색어)", calls.length === 1 && calls[0].q === TOKEN, `calls=${JSON.stringify(calls.map((c) => c.q))}`);
      await ctx.close();
    }

    // ───────── 4. 빠른 재입력 race: 앞 응답 지연 ─────────
    {
      console.log("4. 앞 검색어 응답이 늦게 와도 뒤 검색어 결과 유지");
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      const SLOW = `${TOKEN} A`; // A 글만 매치(1건)
      await page.route(RPC_RE, async (route) => {
        let q = null;
        try {
          q = JSON.parse(route.request().postData() || "{}").q;
        } catch {}
        if (q === SLOW) await sleep(2500); // 앞 검색어만 늦게
        await route.continue();
      });
      await page.goto(`${BASE}${FEED}`, { waitUntil: "networkidle" });
      const input = page.getByTestId("post-search-input");
      await input.fill(SLOW);
      await sleep(400); // 디바운스 통과 → SLOW 요청 출발(응답은 2.5s 뒤)
      await input.fill(`${TOKEN} B`); // B 제목 글 1건 + (본문 매치 아님: "B 두번째 글" 본문엔 'TOKEN 포함')
      await sleep(3500);
      await waitRpcSettled(page);
      const text = await page.evaluate(() => document.body.innerText);
      check("뒤 검색어(B) 결과 노출", text.includes(`${TOKEN} B 제목`));
      check("앞 검색어(A) 늦은 응답 폐기 — A 글 미노출", !text.includes(`${TOKEN} A 제목`));
      await ctx.close();
    }

    // ───────── 5. 2계정 차단 ─────────
    {
      console.log("5. A 가 B 차단 → A 검색에 B 글 없음 / B 는 보임");
      const { error } = await admin.from("user_blocks").insert({ blocker_id: users.A.id, blocked_id: users.B.id });
      if (error) throw new Error("block insert failed: " + error.message);

      const ctxA = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await injectSession(ctxA, await signIn(emailA));
      const pageA = await ctxA.newPage();
      await pageA.goto(`${BASE}${FEED}?q=${encodeURIComponent(TOKEN)}`, { waitUntil: "networkidle" });
      await waitRpcSettled(pageA);
      await sleep(800); // blockedIds 로드(별도 쿼리) 여유
      const textA = await pageA.evaluate(() => document.body.innerText);
      // 'A 제목'은 2페이지 전용이다. 1페이지 차단 판정은 최신 A 글로 확인한다.
      check("A: 본인 글 노출", textA.includes(`${TOKEN} 추가18`));
      check("A: B 제목글 미노출", !textA.includes(`${TOKEN} B 제목`));
      check("A: B 본문매치글 미노출", !textA.includes("B 두번째 글"));
      await ctxA.close();

      const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await injectSession(ctxB, await signIn(emailB));
      const pageB = await ctxB.newPage();
      await pageB.goto(`${BASE}${FEED}?q=${encodeURIComponent(TOKEN)}`, { waitUntil: "networkidle" });
      await waitRpcSettled(pageB);
      await sleep(800);
      const textB = await pageB.evaluate(() => document.body.innerText);
      check("B: 본인 글 2건 노출", textB.includes(`${TOKEN} B 제목`) && textB.includes("B 두번째 글"));
      check("B: A 글도 노출(차단은 A→B 단방향)", textB.includes(`${TOKEN} 추가18`));
      await ctxB.close();
    }

    // ───────── 6. 무결과 ─────────
    {
      console.log("6. 무결과 문구");
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await page.goto(`${BASE}${FEED}?q=${encodeURIComponent(TOKEN + "없음zz")}`, { waitUntil: "networkidle" });
      await waitRpcSettled(page);
      check("빈 결과 문구", await page.getByTestId("post-search-empty").isVisible());
      await ctx.close();
    }

    // ───────── 7. loadMore 지연 경합: 2페이지 응답이 늦게 와도 1페이지 결과 유지 ─────────
    {
      console.log("7. loadMore 지연 경합 — 피드 전환 시 지연 응답 폐기");
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      let page2Intercepted = false;
      await page.route(RPC_RE, async (route) => {
        const body = JSON.parse(route.request().postData() || "{}");
        if (body.before_id !== null && body.before_id !== undefined) {
          page2Intercepted = true;
          await sleep(3000); // 2페이지만 3초 지연
        }
        await route.continue();
      });
      await page.goto(`${BASE}${FEED}?q=${encodeURIComponent(TOKEN)}`, { waitUntil: "networkidle" });
      await waitRpcSettled(page);
      const n1 = await visibleTokenCount(page);
      check("loadMore 전 1페이지 결과 노출(20건)", n1 >= 20, `visible=${n1}`);
      // 스크롤 최하단 → sentinel → loadMore 발동
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(600); // IntersectionObserver 발동 여유
      // loadMore 인-플라이트 중 검색어 지우기 → 일반 피드로 전환
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByTestId("post-search-clear").click();
      await page.waitForFunction(() => window.scrollY === 0);
      await sleep(3500); // 지연 응답 도착 대기
      await waitRpcSettled(page);
      check("2페이지 인터셉트 확인", page2Intercepted, "route not triggered");
      check("검색어 지움 후 ?q 없음(세대 교체)", !new URL(page.url()).searchParams.has("q"), new URL(page.url()).search);
      // 일반 피드 첫 페이지엔 방금 넣은 시드 글(TOKEN 제목)이 그대로 나오므로 'TOKEN 0건'은 정상 동작에서도
      // 실패한다(삼순 NO-GO ③). 대신 **검색 2페이지에만 있는 글**로 누수를 판별한다: 검색은 id desc 라
      // 2페이지 = 최고령 시드 "TOKEN A 제목"(id 최소) 1건뿐, 이 글은 일반 피드 첫 페이지(최신 20건)엔 없다
      // (A제목은 21번째로 밀림). 세대 폐기가 정상이면 전환 후에도 이 글이 안 보여야 한다.
      const afterText = await page.evaluate(() => document.body.innerText || "");
      const leaked = afterText.includes(`${TOKEN} A 제목`);
      check("지연 2페이지(검색) 결과 append 없음(세대 폐기)", !leaked, `A제목 leaked=${leaked}`);
      await ctx.close();
    }

    // ───────── 8. RPC 오류 → '결과 없음' 아닌 오류 문구(오류 은폐 회귀 방지) ─────────
    {
      console.log("8. RPC 500 오류 → post-search-error 노출(post-search-empty 아님)");
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      // RPC 를 500 으로 모킹
      await page.route(RPC_RE, (route) =>
        route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "internal error" }) }),
      );
      await page.goto(`${BASE}${FEED}?q=${encodeURIComponent(TOKEN)}`, { waitUntil: "networkidle" });
      await waitRpcSettled(page);
      check("RPC 500 → 오류 UI 노출", await page.getByTestId("post-search-error").isVisible().catch(() => false));
      check("RPC 500 → 결과없음 UI 미노출(오류 은폐 금지)", !(await page.getByTestId("post-search-empty").isVisible().catch(() => false)));
      await ctx.close();
    }

    void posts;
  } catch (e) {
    failures++;
    console.error("FATAL:", e?.message || e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    // 정리: 차단 → 글 → 계정. 삭제 오류는 catch 후 실패 처리, 잔여 0 건을 확인한다.
    try {
      if (cleanupUsers.length === 2) {
        const { error: blkErr } = await admin.from("user_blocks").delete().eq("blocker_id", cleanupUsers[0]).eq("blocked_id", cleanupUsers[1]);
        if (blkErr) throw new Error("block delete failed: " + blkErr.message);
      }
      if (cleanupPosts.length) {
        const { error: postDelErr } = await admin.from("posts").delete().in("id", cleanupPosts);
        if (postDelErr) throw new Error("post delete failed: " + postDelErr.message);
        // 잔여 0 검증 — soft-delete 컬럼이 없을 때 간단히 count 로 확인.
        const { count, error: cntErr } = await admin.from("posts").select("id", { count: "exact", head: true }).in("id", cleanupPosts);
        if (cntErr) throw new Error("post count check failed: " + cntErr.message);
        if (count !== 0) throw new Error(`post cleanup 잔여 ${count}건 — 삭제 미완료`);
      }
      for (const uid of cleanupUsers) {
        const { error: profErr } = await admin.from("profiles").delete().eq("id", uid);
        if (profErr) throw new Error("profile delete failed: " + profErr.message);
        const { error: authErr } = await admin.auth.admin.deleteUser(uid);
        if (authErr) throw new Error("auth user delete failed: " + authErr.message);
      }
      console.log(`[qa] cleanup done: posts=${cleanupPosts.length} users=${cleanupUsers.length}`);
    } catch (e) {
      console.error("[qa] cleanup error:", e?.message || e);
      failures++;
    }
  }
  console.log(failures ? `\n✗ ${failures} failure(s)` : "\n✓ all passed");
  process.exit(failures ? 1 : 0);
})();
