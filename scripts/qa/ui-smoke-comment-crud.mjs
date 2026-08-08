#!/usr/bin/env node
/**
 * UI 스모크: 댓글/게시글 수정·삭제 v1
 *
 * 용도:
 *   - 배포 후 삼순이(QA)가 한 방에 실 UI까지 검증
 *   - 테스트 유저 2명 일회용 생성 → Playwright 실브라우저 → 스크린샷 → 자동 정리
 *
 * 사용법:
 *     node scripts/qa/ui-smoke-comment-crud.mjs
 *     node scripts/qa/ui-smoke-comment-crud.mjs --headed      # 실제 브라우저 창 열기
 *     node scripts/qa/ui-smoke-comment-crud.mjs --base-url=https://keubo.fan
 *
 * 체크 항목:
 *   1. 로그인 세션 주입 → 댓글 입력 가능 상태
 *   2. 본인 게시글에 ⋯ 메뉴 표출 (게시글 + 댓글)
 *   3. 다른 유저 게시글·댓글에는 ⋯ 미표출
 *   4. 댓글 수정/삭제 (RLS 통과, count trigger)
 *   5. 게시글 삭제 + CASCADE (comments 함께 제거)
 *   6. B가 A 콘텐츠에 UPDATE/DELETE 시도 시 RLS 차단
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPABASE_URL, ANON, SERVICE_ROLE, REF, BASE } from "./_env.mjs";

const { chromium } = playwright;
const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(__dirname, "../../tmp/qa-screenshots");
mkdirSync(SHOT_DIR, { recursive: true });

const HEADED = process.argv.includes("--headed");
const BASE_URL = (process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1]) || BASE;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const pass = (name) => console.log(`  ✅  ${name}`);
const fail = (name, msg) => console.log(`  ❌  ${name}  ${msg || ""}`);

const STAMP = Date.now().toString(36);
const emailA = `qa-A-${STAMP}@keubo.fan`;
const emailB = `qa-B-${STAMP}@keubo.fan`;
const pw = "QaTest!" + STAMP;
const cleanupIds = [];
let passCount = 0;
let failCount = 0;
const check = (name, cond, msg) => {
  if (cond) {
    pass(name);
    passCount++;
  } else {
    fail(name, msg);
    failCount++;
  }
};

async function signIn(email) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pw }),
  });
  if (!r.ok) throw new Error(`sign-in ${email} failed: ${r.status}`);
  return r.json();
}

async function seedUsers() {
  log("create test users...");
  const { data: uA, error: eA } = await admin.auth.admin.createUser({
    email: emailA,
    password: pw,
    email_confirm: true,
  });
  if (eA) throw eA;
  cleanupIds.push(uA.user.id);
  const { data: uB, error: eB } = await admin.auth.admin.createUser({
    email: emailB,
    password: pw,
    email_confirm: true,
  });
  if (eB) throw eB;
  cleanupIds.push(uB.user.id);

  for (const u of [uA.user, uB.user]) {
    const nickname = "qa" + u.email.split("@")[0].replace(/-/g, "").slice(0, 12);
    const { error: pErr } = await admin.from("profiles").insert({
      id: u.id,
      nickname,
      team_id: 2002,
    });
    if (pErr) throw new Error("profile insert failed: " + pErr.message);
  }
  const sessA = await signIn(emailA);
  const sessB = await signIn(emailB);
  log("users ready:", uA.user.id.slice(0, 8), uB.user.id.slice(0, 8));
  return { uA: uA.user, uB: uB.user, sessA, sessB };
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
  const cookieVal = `base64-${Buffer.from(ls).toString("base64")}`;
  const host = new URL(BASE_URL).hostname;
  await ctx.addCookies([
    {
      name: cookieName,
      value: cookieVal,
      domain: host,
      path: "/",
      httpOnly: false,
      secure: true,
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

async function main() {
  const { uA, uB, sessA, sessB } = await seedUsers();

  // Seed one post + one comment by A
  const { data: seedPost, error: spErr } = await admin
    .from("posts")
    .insert({
      title: `[QA-UI-${STAMP}] 댓글수정삭제 스모크`,
      content: "이 게시글은 UI QA용 일회성입니다.",
      author_id: uA.id,
      board_type: "team",
      board_id: "doosan",
      content_type: "general",
      // 공개범위 필수(20260807020000 트리거) — 무태그 seed 는 23514 로 거절된다.
      // 팀 보드 글이므로 그 보드의 팀을 그대로 태그한다.
      team_tags: ["doosan"],
      comment_count: 0,
      like_count: 0,
    })
    .select()
    .single();
  if (spErr) throw spErr;

  const { data: seedCmt } = await admin
    .from("comments")
    .insert({ post_id: seedPost.id, author_id: uA.id, content: "original QA comment" })
    .select()
    .single();

  const postPath = `/community/teams/${seedPost.board_id}/posts/${seedPost.id}`;
  log("post url:", BASE_URL + postPath);

  const browser = await chromium.launch({ headless: !HEADED });

  // --- A as author ---
  const ctxA = await browser.newContext({ viewport: { width: 414, height: 896 } });
  await injectSession(ctxA, sessA);
  const pageA = await ctxA.newPage();
  await pageA.goto(`${BASE_URL}${postPath}`, { waitUntil: "networkidle" });
  await pageA.waitForTimeout(4000);
  await pageA.screenshot({ path: `${SHOT_DIR}/A-own-post.png`, fullPage: true });

  const aMoreBtns = await pageA.locator('button[aria-label*="메뉴"]').count();
  check("[2] A 본인 콘텐츠 ⋯ 메뉴 표출 (기대: 2, 게시글+댓글)", aMoreBtns === 2, `found=${aMoreBtns}`);

  // Click post menu and check 수정/삭제 options
  if (aMoreBtns >= 2) {
    await pageA.locator('button[aria-label*="게시글"]').first().click();
    await pageA.waitForTimeout(400);
    const editBtn = await pageA.locator('text=수정').first().isVisible();
    const delBtn = await pageA.locator('text=삭제').first().isVisible();
    check("[2a] 게시글 메뉴 → 수정/삭제 옵션 노출", editBtn && delBtn);
    await pageA.keyboard.press("Escape").catch(() => {});
  }

  // --- B as other user ---
  const ctxB = await browser.newContext({ viewport: { width: 414, height: 896 } });
  await injectSession(ctxB, sessB);
  const pageB = await ctxB.newPage();
  await pageB.goto(`${BASE_URL}${postPath}`, { waitUntil: "networkidle" });
  await pageB.waitForTimeout(4000);
  await pageB.screenshot({ path: `${SHOT_DIR}/B-others-post.png`, fullPage: true });

  const bMoreBtns = await pageB.locator('button[aria-label*="메뉴"]').count();
  check("[3] B 다른 유저 콘텐츠 ⋯ 메뉴 숨김 (기대: 0)", bMoreBtns === 0, `found=${bMoreBtns}`);

  // RLS + trigger simulation via user-session clients
  const userAClient = createClient(SUPABASE_URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${sessA.access_token}` } },
  });
  const userBClient = createClient(SUPABASE_URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${sessB.access_token}` } },
  });

  // B adds a comment to push count = 2
  const { data: cmtB } = await admin
    .from("comments")
    .insert({ post_id: seedPost.id, author_id: uB.id, content: "B comment" })
    .select()
    .single();
  const { data: p1 } = await admin.from("posts").select("comment_count").eq("id", seedPost.id).single();
  check("[4a] 댓글 INSERT 후 comment_count = 2", p1.comment_count === 2, `got=${p1.comment_count}`);

  // B tries to update A's comment (RLS block)
  const { error: bUpdA, count: bUpdACount } = await userBClient
    .from("comments")
    .update({ content: "hacked by B" })
    .eq("id", seedCmt.id)
    .select();
  const { data: cmtStill } = await admin.from("comments").select("content").eq("id", seedCmt.id).single();
  check("[6a] B가 A 댓글 UPDATE 시 RLS 차단 (내용 원복)", cmtStill.content === "original QA comment", `got=${cmtStill.content}`);

  // B tries to delete A's post
  await userBClient.from("posts").delete().eq("id", seedPost.id);
  const { data: postStill } = await admin.from("posts").select("id").eq("id", seedPost.id).maybeSingle();
  check("[6b] B가 A 게시글 DELETE 시 RLS 차단 (post 존재)", !!postStill);

  // A updates own comment
  const { error: aUpdE } = await userAClient
    .from("comments")
    .update({ content: "edited by A", updated_at: new Date().toISOString() })
    .eq("id", seedCmt.id);
  const { data: cmtAfterUpd } = await admin.from("comments").select("content, updated_at").eq("id", seedCmt.id).single();
  check("[4b] A 본인 댓글 수정 성공", !aUpdE && cmtAfterUpd.content === "edited by A");
  check("[4c] updated_at 컬럼 채워짐", !!cmtAfterUpd.updated_at);

  // A deletes own comment
  const { error: aDelCE } = await userAClient.from("comments").delete().eq("id", seedCmt.id);
  check("[4d] A 본인 댓글 삭제 성공", !aDelCE);
  const { data: p2 } = await admin.from("posts").select("comment_count").eq("id", seedPost.id).single();
  check("[4e] 댓글 DELETE 후 comment_count = 1 (trigger)", p2.comment_count === 1, `got=${p2.comment_count}`);

  // A deletes own post
  const { error: aDelPE } = await userAClient.from("posts").delete().eq("id", seedPost.id);
  check("[5a] A 본인 게시글 삭제 성공", !aDelPE);
  const { data: postGone } = await admin.from("posts").select("id").eq("id", seedPost.id).maybeSingle();
  check("[5b] 게시글 삭제 후 DB에서 제거됨", !postGone);
  const { data: orphanCmts } = await admin.from("comments").select("id").eq("post_id", seedPost.id);
  check("[5c] 댓글 CASCADE 삭제됨", orphanCmts.length === 0);

  await browser.close();

  console.log(`\n=== RESULT: ${passCount}/${passCount + failCount} PASS ===`);
  console.log(`screenshots: ${SHOT_DIR}`);
  return failCount === 0;
}

async function teardown() {
  for (const uid of cleanupIds) {
    try {
      await admin.auth.admin.deleteUser(uid);
    } catch {}
  }
}

let ok = false;
try {
  ok = await main();
} catch (e) {
  console.error("\n[ERROR]", e.message);
} finally {
  await teardown();
}
process.exit(ok ? 0 : 1);
