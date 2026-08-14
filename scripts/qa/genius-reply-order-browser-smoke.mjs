#!/usr/bin/env node
/**
 * #1157 수동 Preview E2E — 전용 계정으로 질문 2개 선렌더 → B답변 → A답변을
 * 실제 Supabase Realtime로 관측하고 content ↔ question_message_id 및 typing 종료를 확인한다.
 *
 * 실행: node scripts/qa/genius-reply-order-browser-smoke.mjs --base-url=https://<preview>
 */
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { SUPABASE_URL, ANON, SERVICE_ROLE, REF } from "./_env.mjs";

const BASE_URL = process.argv.find((arg) => arg.startsWith("--base-url="))?.slice(11);
const SCREENSHOT = process.argv.find((arg) => arg.startsWith("--screenshot="))?.slice(13);
if (!BASE_URL) throw new Error("--base-url=<ready Preview URL>가 필요하다");
const GENIUS_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
const OUTBOX_KEY = "baseball-genius-question-outbox-v1";
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

async function createSession(email) {
  const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(`magiclink 실패: ${error.message}`);
  const verify = await fetch(`${SUPABASE_URL}/auth/v1/verify?token=${link.properties.hashed_token}&type=magiclink`, { redirect: "manual" });
  const fragment = new URLSearchParams((verify.headers.get("location") || "").split("#")[1] || "");
  const accessToken = fragment.get("access_token");
  if (!accessToken) throw new Error(`세션 교환 실패: HTTP ${verify.status}`);
  const user = await (await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${accessToken}` } })).json();
  return {
    access_token: accessToken,
    refresh_token: fragment.get("refresh_token"),
    expires_in: 3600,
    expires_at: Number(fragment.get("expires_at")),
    token_type: "bearer",
    user: { id: user.id, email: user.email, aud: user.aud, role: user.role, app_metadata: {}, user_metadata: {}, created_at: user.created_at },
  };
}

async function sendAnswer(userId, questionMessageId, content, suffix) {
  // query-guard: bounded -- admin_send_ops_message는 대상 대화 1행만 반환한다.
  const { data, error } = await admin.rpc("admin_send_ops_message", {
    p_system_user_id: GENIUS_ID,
    p_user_id: userId,
    p_content: content,
    p_image_urls: [],
    p_preview: content,
    p_origin: "dm",
    p_dedup_key: `qa-genius-order:${userId}:${suffix}`,
    p_payload: { type: "baseball_genius_reply", reply_kind: "answer", match_path: "dictionary", question_message_id: questionMessageId },
  });
  if (error) throw new Error(`답변 RPC 실패: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  assert.ok(Number.isSafeInteger(row?.message_id), `답변 message_id 누락: ${JSON.stringify(row)}`);
  return row.message_id;
}

async function main() {
  const browser = await playwright.chromium.launch();
  let userId = null;
  let conversationId = null;
  try {
    const email = `qa-genius-order-${Date.now()}@keubo-qa.invalid`;
    const password = `Qa!${Math.random().toString(36).slice(2)}Aa1`;
    const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (createError) throw new Error(`테스트 계정 생성 실패: ${createError.message}`);
    userId = created.user.id;

    const [user1_id, user2_id] = [userId, GENIUS_ID].sort();
    const { data: conversation, error: conversationError } = await admin
      .from("dm_conversations").insert({ user1_id, user2_id }).select("id").single();
    if (conversationError) throw new Error(`대화 생성 실패: ${conversationError.message}`);
    conversationId = conversation.id;

    const { data: questions, error: questionError } = await admin.from("dm_messages").insert([
      { conversation_id: conversationId, sender_id: userId, content: "QA 첫 질문" },
      { conversation_id: conversationId, sender_id: userId, content: "QA 둘째 질문" },
    ]).select("id,content").order("id", { ascending: true });
    if (questionError || questions?.length !== 2) throw new Error(`질문 삽입 실패: ${questionError?.message ?? "2행 아님"}`);
    const [q1, q2] = questions;

    const session = await createSession(email);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const authKey = `sb-${REF}-auth-token`;
    const origin = new URL(BASE_URL);
    await context.addCookies([{
      name: authKey,
      value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64")}`,
      domain: origin.hostname,
      path: "/",
      httpOnly: false,
      secure: origin.protocol === "https:",
      sameSite: "Lax",
      ...(Number.isFinite(session.expires_at) ? { expires: session.expires_at } : {}),
    }]);
    const outbox = JSON.stringify([
      { conversationId, messageId: q1.id, attempts: 0, acknowledged: true, responsePendingSinceMs: Date.now() },
      { conversationId, messageId: q2.id, attempts: 0, acknowledged: true, responsePendingSinceMs: Date.now() },
    ]);
    await context.addInitScript(([key, value, outboxKey, outboxValue]) => {
      window.localStorage.setItem(key, value);
      window.localStorage.setItem(outboxKey, outboxValue);
    }, [authKey, JSON.stringify(session), OUTBOX_KEY, outbox]);

    const page = await context.newPage();
    await page.goto(`${BASE_URL}/messages/${conversationId}`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForSelector(`[data-message-id="${q1.id}"]`, { timeout: 20_000 });
    await page.waitForSelector(`[data-message-id="${q2.id}"]`, { timeout: 20_000 });
    await page.waitForSelector(`[data-genius-typing-question-id="${q1.id}"]`, { timeout: 20_000 });
    await page.waitForSelector(`[data-genius-typing-question-id="${q2.id}"]`, { timeout: 20_000 });

    const bId = await sendAnswer(userId, q2.id, "QA 둘째 exact 답변", "b");
    const b = page.locator(`[data-message-id="${bId}"][data-genius-question-id="${q2.id}"]`);
    await b.waitFor({ timeout: 20_000 });
    await assert.doesNotReject(() => b.getByText("QA 둘째 exact 답변", { exact: true }).waitFor());
    await page.waitForSelector(`[data-genius-typing-question-id="${q2.id}"]`, { state: "detached", timeout: 20_000 });
    assert.equal(await page.locator(`[data-genius-typing-question-id="${q1.id}"]`).count(), 1, "B답변 뒤 A typing은 유지돼야 한다");

    const aId = await sendAnswer(userId, q1.id, "QA 첫 exact 답변", "a");
    const a = page.locator(`[data-message-id="${aId}"][data-genius-question-id="${q1.id}"]`);
    await a.waitFor({ timeout: 20_000 });
    await assert.doesNotReject(() => a.getByText("QA 첫 exact 답변", { exact: true }).waitFor());
    assert.doesNotMatch(await a.innerText(), /둘째 exact 답변/);
    assert.doesNotMatch(await b.innerText(), /첫 exact 답변/);
    await page.waitForSelector("[data-genius-typing-question-id]", { state: "detached", timeout: 20_000 });
    if (SCREENSHOT) await page.screenshot({ path: SCREENSHOT, fullPage: true });

    console.log(`✅ Preview 로그인 E2E PASS — q1=${q1.id}↔a1=${aId}, q2=${q2.id}↔b2=${bId}, typing=0`);
    await context.close();
  } finally {
    await browser.close();
    if (conversationId) {
      await admin.from("dm_messages").delete().eq("conversation_id", conversationId);
      await admin.from("dm_conversations").delete().eq("id", conversationId);
    }
    if (userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) console.error(`테스트 계정 삭제 실패: ${error.message}`);
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
