#!/usr/bin/env node
/**
 * UI 스모크: 커뮤니티 검색 v1 (전체글 탭) — End-User Level (Playwright 실브라우저, 전용 테스트 계정 2개).
 *
 * 고정하는 계약(삼순 계획 리뷰 ④ + 정정 ①):
 *  1. `?q=` 진입 → 결과 카드 → 상세 → 뒤로가기: `?q=` 유지 + 검색 결과가 그대로(검색어별 복원 키).
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
  const rows = [
    { author_id: users.A.id, board_type: "free", board_id: "general", title: `${TOKEN} A 제목`, content: "본문 A" },
    { author_id: users.B.id, board_type: "free", board_id: "general", title: `${TOKEN} B 제목`, content: "본문 B" },
    { author_id: users.B.id, board_type: "free", board_id: "general", title: "B 두번째 글", content: `본문에 ${TOKEN} 포함` },
  ];
  const { data: posts, error } = await admin.from("posts").insert(rows).select("id, author_id, title");
  if (error) throw new Error("post insert failed: " + error.message);
  cleanupPosts.push(...posts.map((p) => p.id));
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

(async () => {
  let browser;
  try {
    console.log(`[qa] base=${BASE} token=${TOKEN}`);
    const { users, posts } = await seed();
    browser = await chromium.launch();

    // ───────── 1. ?q= 진입 → 상세 → 뒤로가기 (익명) ─────────
    {
      console.log("1. ?q= 진입 → 상세 → 뒤로가기");
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      const calls = trackRpc(page);
      await page.goto(`${BASE}${FEED}?q=${encodeURIComponent(TOKEN)}`, { waitUntil: "networkidle" });
      await waitRpcSettled(page);
      check("입력창에 q 복원", (await page.getByTestId("post-search-input").inputValue()) === TOKEN);
      const n1 = await visibleTokenCount(page);
      check("검색 결과 3건 노출(제목2+본문1)", n1 >= 3, `visible=${n1}`);
      check("초기 진입 RPC 1회", calls.length === 1, `calls=${calls.length}`);
      // 상세 진입: TOKEN 이 있는 첫 링크
      const link = page.locator(`a[href*="/community/"]`).filter({ hasText: TOKEN }).first();
      await link.click();
      await page.waitForURL((u) => /\/community\/.+\/\d+/.test(u.pathname), { timeout: 15000 });
      check("상세 진입", true, page.url().replace(BASE, ""));
      await page.goBack({ waitUntil: "networkidle" });
      await waitRpcSettled(page);
      const u = new URL(page.url());
      check("뒤로가기 후 ?q= 유지", u.pathname === FEED && u.searchParams.get("q") === TOKEN, u.search);
      check("뒤로가기 후 결과 유지", (await visibleTokenCount(page)) >= 3);
      check("뒤로가기 후 입력창 값 유지", (await page.getByTestId("post-search-input").inputValue()) === TOKEN);
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
      // 브라우저 IME 를 흉내: compositionstart → (isComposing) input × N → compositionend → 마지막 input
      await page.evaluate(
        ([tok]) => {
          const el = document.querySelector('[data-testid="post-search-input"]');
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          const fire = (type, init) => el.dispatchEvent(new (type.startsWith("composition") ? CompositionEvent : InputEvent)(type, { bubbles: true, ...init }));
          fire("compositionstart", {});
          const partials = ["ㅋ", "큐", "큐ㅇ", "큐에", "큐에ㅇ", "큐에이"];
          for (const p of partials) {
            setter.call(el, p);
            fire("input", { isComposing: true, inputType: "insertCompositionText", data: p });
          }
          setter.call(el, tok);
          fire("compositionend", { data: tok });
          fire("input", { isComposing: false, inputType: "insertText", data: tok });
        },
        [TOKEN],
      );
      await sleep(150);
      check("조합 중 RPC 0회(150ms 시점)", calls.length === 0, `calls=${calls.length}`);
      await sleep(800);
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
      check("A: 본인 글 노출", textA.includes(`${TOKEN} A 제목`));
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
      check("B: A 글도 노출(차단은 A→B 단방향)", textB.includes(`${TOKEN} A 제목`));
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

    void posts;
  } catch (e) {
    failures++;
    console.error("FATAL:", e?.message || e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    // 정리: 차단 → 글 → 계정
    try {
      if (cleanupUsers.length === 2) {
        await admin.from("user_blocks").delete().eq("blocker_id", cleanupUsers[0]).eq("blocked_id", cleanupUsers[1]);
      }
      if (cleanupPosts.length) await admin.from("posts").delete().in("id", cleanupPosts);
      for (const uid of cleanupUsers) {
        await admin.from("profiles").delete().eq("id", uid);
        await admin.auth.admin.deleteUser(uid);
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
