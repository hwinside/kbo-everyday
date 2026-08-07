#!/usr/bin/env node
/**
 * 기사 댓글 신고 UI 회귀:
 * 작성자 + 서로 다른 신고자 3명을 만들고, 3번째 신고를 실제 모바일 UI로 제출한다.
 * 신고 시트 레이어, 자동 블라인드, 댓글 즉시 제거, 카드 댓글 수 동기화를 한 흐름으로 검증한다.
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { existsSync } from "node:fs";
import { ANON, BASE, REF, SERVICE_ROLE, SUPABASE_URL } from "./_env.mjs";

const { chromium } = playwright;
const BASE_URL = process.argv.find((arg) => arg.startsWith("--base-url="))?.split("=")[1] || BASE;
const HEADED = process.argv.includes("--headed");
const SYSTEM_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const STAMP = Date.now().toString(36);
const PASSWORD = `QaNews!${STAMP}`;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userIds = [];
let postId = null;
let commentId = null;
let replyId = null;
let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

async function createUser(label) {
  const email = `qa-news-${label}-${STAMP}@keubo.fan`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw error || new Error(`create ${label} failed`);
  userIds.push(data.user.id);
  const { error: profileError } = await admin.from("profiles").insert({
    id: data.user.id,
    nickname: `qa뉴스${label}${STAMP.slice(-4)}`,
    team_id: 2002,
  });
  if (profileError) throw profileError;
  return { id: data.user.id, email };
}

async function signIn(email) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status}`);
  return response.json();
}

async function injectSession(context, session) {
  const storageKey = `sb-${REF}-auth-token`;
  const value = JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    token_type: "bearer",
    user: session.user,
  });
  const base = new URL(BASE_URL);
  await context.addCookies([{
    name: storageKey,
    value: `base64-${Buffer.from(value).toString("base64")}`,
    domain: base.hostname,
    path: "/",
    httpOnly: false,
    secure: base.protocol === "https:",
    sameSite: "Lax",
    expires: session.expires_at,
  }]);
  await context.addInitScript(([key, stored]) => localStorage.setItem(key, stored), [storageKey, value]);
}

async function seed() {
  const [author, reporter1, reporter2, reporter3] = await Promise.all([
    createUser("author"),
    createUser("r1"),
    createUser("r2"),
    createUser("r3"),
  ]);
  const { data: post, error: postError } = await admin
    .from("posts")
    .insert({
      author_id: author.id,
      board_type: "announcement",
      board_id: `qa-news-report-${STAMP}`,
      content_type: "general",
      title: "기사 댓글 신고 QA",
      content: "QA bridge",
      // 공개범위 필수(20260807020000 트리거) — 무태그 seed 는 23514 로 거절된다.
      // 기사 브릿지는 특정 팀 소유가 아니므로 운영 경로(news/discussion route)와 동일하게 10팀 전부.
      team_tags: ["lg", "doosan", "kt", "ssg", "nc", "kia", "lotte", "samsung", "hanwha", "kiwoom"],
      is_hidden: true,
    })
    .select("id")
    .single();
  if (postError || !post) throw postError || new Error("post seed failed");
  postId = post.id;

  const { data: comment, error: commentError } = await admin
    .from("comments")
    .insert({ post_id: postId, author_id: author.id, content: `신고대상-${STAMP}` })
    .select("id")
    .single();
  if (commentError || !comment) throw commentError || new Error("comment seed failed");
  commentId = comment.id;

  const { data: reply, error: replyError } = await admin
    .from("comments")
    .insert({
      post_id: postId,
      author_id: author.id,
      parent_id: commentId,
      content: `신고대상답글-${STAMP}`,
    })
    .select("id")
    .single();
  if (replyError || !reply) throw replyError || new Error("reply seed failed");
  replyId = reply.id;

  const { error: reportsError } = await admin.from("reports").insert([
    { reporter_id: reporter1.id, target_type: "comment", target_id: commentId, reason: "abuse" },
    { reporter_id: reporter2.id, target_type: "comment", target_id: commentId, reason: "abuse" },
  ]);
  if (reportsError) throw reportsError;
  return { reporter3, session: await signIn(reporter3.email) };
}

async function run() {
  const { session } = await seed();
  const browser = await chromium.launch({
    headless: !HEADED,
    ...(existsSync(SYSTEM_CHROME) ? { executablePath: SYSTEM_CHROME } : {}),
  });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await injectSession(context, session);
    const page = await context.newPage();
    await page.route("**/api/whats-new", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{
          id: `qa-${STAMP}`,
          title: "기사 댓글 신고 QA",
          summary: "신고 UI 검증",
          body: "신고 UI 검증",
          cta_label: null,
          cta_path: null,
          published_at: new Date().toISOString(),
          post_id: postId,
          target_platform: "all",
        }]),
      });
    });

    await page.goto(`${BASE_URL}/whats-new`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /댓글 2/ }).click();
    await page.getByText(`신고대상-${STAMP}`).waitFor({ state: "visible" });
    await page.getByText(`신고대상답글-${STAMP}`).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "댓글 메뉴" }).first().click();
    await page.getByRole("button", { name: "신고" }).click();

    const reportTitle = page.getByRole("heading", { name: "🚨 신고하기" });
    await reportTitle.waitFor({ state: "visible" });
    const reportLayer = reportTitle.locator("xpath=ancestor::div[contains(@class,'fixed')]").first();
    const zIndex = await reportLayer.evaluate((element) => Number(getComputedStyle(element).zIndex));
    check("신고 시트가 댓글 시트보다 위에 표시", zIndex > 9999, `z-index=${zIndex}`);

    await page.getByRole("button", { name: /스팸\/도배/ }).click();
    await page.getByRole("button", { name: "신고하기", exact: true }).click();
    await page.getByText("신고가 접수되었습니다").waitFor({ state: "visible" });
    await page.getByText(`신고대상-${STAMP}`).waitFor({ state: "detached" });

    const { data: blinded } = await admin.from("comments").select("is_hidden").eq("id", commentId).single();
    check("서로 다른 3계정 신고 후 댓글 블라인드", blinded?.is_hidden === true);
    const { data: visibleReply } = await admin.from("comments").select("is_hidden").eq("id", replyId).single();
    check("루트 블라인드 후 답글 row는 visible 상태 유지", visibleReply?.is_hidden === false);

    await page.waitForTimeout(1700);
    await page.getByRole("button", { name: "댓글 닫기" }).click().catch(async () => {
      await page.locator('button:has(svg.lucide-x)').first().click();
    });
    await page.getByRole("button", { name: /댓글 0/ }).waitFor({ state: "visible" });
    check("블라인드 직후 카드 댓글 수 0 동기화", true);
  } finally {
    await browser.close();
  }
}

async function cleanup() {
  const cleanupErrors = [];
  const runDelete = async (label, operation) => {
    const { error } = await operation;
    if (error) cleanupErrors.push(`${label}: ${error.message}`);
  };

  if (commentId !== null) {
    await runDelete(
      "reports delete",
      admin.from("reports").delete().eq("target_type", "comment").eq("target_id", commentId),
    );
    await runDelete(
      "blind notice delete",
      admin.from("report_blind_notices").delete().eq("target_type", "comment").eq("target_id", commentId),
    );
  }
  if (postId !== null) await runDelete("post delete", admin.from("posts").delete().eq("id", postId));
  if (userIds.length > 0) {
    await runDelete("profiles delete", admin.from("profiles").delete().in("id", userIds));
  }
  for (const id of userIds) {
    const { error: hardDeleteError } = await admin.auth.admin.deleteUser(id);
    if (hardDeleteError) {
      const { error: softDeleteError } = await admin.auth.admin.deleteUser(id, true);
      if (softDeleteError) {
        cleanupErrors.push(`auth delete ${id}: ${softDeleteError.message || JSON.stringify(softDeleteError)}`);
      }
    }
  }

  const [reports, blindNotices, posts, profiles, comments] = await Promise.all([
    commentId === null
      ? Promise.resolve({ data: [], error: null })
      : admin.from("reports").select("id").eq("target_type", "comment").eq("target_id", commentId),
    commentId === null
      ? Promise.resolve({ data: [], error: null })
      : admin.from("report_blind_notices").select("id").eq("target_type", "comment").eq("target_id", commentId),
    postId === null
      ? Promise.resolve({ data: [], error: null })
      : admin.from("posts").select("id").eq("id", postId),
    userIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : admin.from("profiles").select("id").in("id", userIds),
    postId === null
      ? Promise.resolve({ data: [], error: null })
      : admin.from("comments").select("id").eq("post_id", postId),
  ]);
  for (const [label, result] of [
    ["reports", reports],
    ["blind notices", blindNotices],
    ["posts", posts],
    ["profiles", profiles],
    ["comments", comments],
  ]) {
    if (result.error) cleanupErrors.push(`${label} verify: ${result.error.message}`);
    if ((result.data ?? []).length > 0) cleanupErrors.push(`${label} residue: ${result.data.length}`);
  }
  for (const id of userIds) {
    const { data, error } = await admin.auth.admin.getUserById(id);
    if (!error && data.user && !data.user.deleted_at) cleanupErrors.push(`active auth residue: ${id}`);
  }
  if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join("; "));
  console.log("PASS cleanup residue 0 (active auth/profile/post/comment/report/blind notice)");
}

try {
  await run();
} catch (error) {
  failed += 1;
  console.error("FAIL ui smoke", error);
} finally {
  try {
    await cleanup();
  } catch (error) {
    failed += 1;
    console.error("FAIL cleanup", error);
  }
}

console.log(`news comment report UI: ${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
