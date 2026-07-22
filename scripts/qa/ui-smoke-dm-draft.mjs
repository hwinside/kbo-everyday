#!/usr/bin/env node
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { SUPABASE_URL, ANON, SERVICE_ROLE, REF, BASE } from "./_env.mjs";

const BASE_URL = process.argv.find((arg) => arg.startsWith("--base-url="))?.split("=")[1] ?? BASE;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stamp = Date.now().toString(36);
const password = `QaDm!${stamp}`;
const emails = [`qa-dm-a-${stamp}@keubo.fan`, `qa-dm-b-${stamp}@keubo.fan`];
const userIds = [];
let browser;
const uploadedPaths = [];
const OPERATOR_USER_ID = "7b58d68e-e212-40aa-a96d-5018cb82cc81";

async function signIn(email) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status}`);
  return response.json();
}

async function injectSession(context, session) {
  const key = `sb-${REF}-auth-token`;
  const value = JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    token_type: "bearer",
    user: session.user,
  });
  const url = new URL(BASE_URL);
  await context.addCookies([{
    name: key,
    value: `base64-${Buffer.from(value).toString("base64")}`,
    domain: url.hostname,
    path: "/",
    httpOnly: false,
    secure: url.protocol === "https:",
    sameSite: "Lax",
    expires: session.expires_at,
  }]);
  await context.addInitScript(([storageKey, storageValue]) => {
    window.localStorage.setItem(storageKey, storageValue);
  }, [key, value]);
}

async function conversationBetween(a, b) {
  const [u1, u2] = [a, b].sort();
  const { data, error } = await admin
    .from("dm_conversations")
    .select("id, last_message")
    .eq("user1_id", u1)
    .eq("user2_id", u2)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function main() {
  for (const [index, email] of emails.entries()) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    userIds.push(data.user.id);
    const { error: profileError } = await admin.from("profiles").insert({
      id: data.user.id,
      nickname: `qaD${index}${stamp}`.slice(0, 12),
      team_id: index === 0 ? 1990 : 2002,
    });
    if (profileError) throw profileError;
  }

  const session = await signIn(emails[0]);
  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await injectSession(context, session);
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/profile/${userIds[1]}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "쪽지" }).click();
  await page.waitForURL(`**/messages/new-${userIds[1]}`);
  if (await conversationBetween(userIds[0], userIds[1])) {
    throw new Error("opening the composer created an empty conversation");
  }

  const content = `DM draft QA ${stamp}`;
  await page.getByPlaceholder("쪽지를 입력하세요...").fill(content);
  await page.getByRole("button", { name: "쪽지 보내기" }).click();
  await page.waitForURL(/\/messages\/[0-9a-f-]{36}$/);
  const conversation = await conversationBetween(userIds[0], userIds[1]);
  if (!conversation || conversation.last_message !== content) {
    throw new Error("first send did not create the conversation with its preview");
  }
  await admin.from("user_blocks").insert({ blocker_id: userIds[1], blocked_id: userIds[0] });
  const blockedDraft = `blocked draft ${stamp}`;
  await page.getByPlaceholder("쪽지를 입력하세요...").fill(blockedDraft);
  await page.getByRole("button", { name: "쪽지 보내기" }).click();
  await page.getByRole("alert").getByText("현재 이 대화에서는 쪽지를 보낼 수 없어요.").waitFor();
  if (await page.getByPlaceholder("쪽지를 입력하세요...").inputValue() !== blockedDraft) {
    throw new Error("blocked send did not preserve the draft");
  }
  await admin.from("user_blocks").delete().eq("blocker_id", userIds[1]).eq("blocked_id", userIds[0]);

  await page.goto(`${BASE_URL}/messages/new-${OPERATOR_USER_ID}`, { waitUntil: "networkidle" });
  if (await conversationBetween(userIds[0], OPERATOR_USER_ID)) {
    throw new Error("opening the operator draft created an empty conversation");
  }
  await page.locator('input[type="file"]').setInputFiles({
    name: "dm-draft.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII=", "base64"),
  });
  await page.getByRole("button", { name: "첨부 이미지 제거" }).waitFor();
  if (await conversationBetween(userIds[0], OPERATOR_USER_ID)) {
    throw new Error("uploading the first photo created an empty conversation");
  }
  await page.getByRole("button", { name: "쪽지 보내기" }).click();
  await page.waitForURL(/\/messages\/[0-9a-f-]{36}$/);
  const operatorConversation = await conversationBetween(userIds[0], OPERATOR_USER_ID);
  if (!operatorConversation || operatorConversation.last_message !== "[사진]") {
    throw new Error("photo-only first send did not create the expected preview");
  }
  const { data: photoMessage } = await admin
    .from("dm_messages")
    .select("image_urls")
    .eq("conversation_id", operatorConversation.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (!photoMessage?.image_urls?.length) throw new Error("photo-only first send lost its image");
  for (const url of photoMessage.image_urls) {
    const marker = "/storage/v1/object/public/photos/";
    const index = url.indexOf(marker);
    if (index >= 0) uploadedPaths.push(decodeURIComponent(url.slice(index + marker.length)));
  }

  console.log("dm draft UI smoke: 7/7 PASS");
  await browser.close();
  browser = null;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
    if (userIds.length === 2) {
      for (const [left, right] of [[userIds[0], userIds[1]], [userIds[0], OPERATOR_USER_ID]]) {
        const [u1, u2] = [left, right].sort();
        const { data } = await admin
          .from("dm_conversations")
          .select("id")
          .eq("user1_id", u1)
          .eq("user2_id", u2)
          .maybeSingle();
        if (data) await admin.from("dm_conversations").delete().eq("id", data.id);
      }
      await admin.from("user_blocks").delete().eq("blocker_id", userIds[0]).eq("blocked_id", userIds[1]);
      await admin.from("user_blocks").delete().eq("blocker_id", userIds[1]).eq("blocked_id", userIds[0]);
    }
    if (uploadedPaths.length) await admin.storage.from("photos").remove(uploadedPaths);
    if (userIds.length) await admin.from("profiles").delete().in("id", userIds);
    for (const id of userIds) await admin.auth.admin.deleteUser(id);
  });
