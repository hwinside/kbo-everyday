#!/usr/bin/env node
/**
 * 크관 GIPHY End-User QA
 * - 실제 로그인 세션으로 일반 GIF 메시지와 1-depth GIF 답글을 UI에서 전송
 * - 피커를 열면 추가 클릭 없이 Trending 1회로 표시, 검색은 명시적으로 제출
 * - chat_messages 실제 insert와 compact canonical URL(120자 이하)을 검증
 * - 일회용 사용자/메시지는 종료 시 자동 정리
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { SUPABASE_URL, ANON, SERVICE_ROLE } from "./_env.mjs";

const { chromium } = playwright;
const BASE_URL = process.argv.find((arg) => arg.startsWith("--base-url="))?.split("=")[1]
  ?? "http://127.0.0.1:3107";
const GAME_ID = "20260502NCLG0";
const ROOM_ID = `game:${GAME_ID}`;
const ROOT_GIF_ID = "ICOgUNjpvO0PC";
const REPLY_GIF_ID = "3o7aD2saalBwwftBIY";
const canonicalUrl = (id) => `https://media.giphy.com/media/${id}/giphy.gif`;
const longPickerUrl = (id) =>
  `https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjEx${"x".repeat(80)}/${id}/200.gif?cid=qa&rid=200.gif&ct=g`;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now().toString(36);
const email = `qa-gamechat-giphy-${stamp}@keubo.fan`;
const password = `QaGiphy!${stamp}`;
let userId = null;
const insertedIds = [];
let browser = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  ✅ ${message}`);
}

async function waitForInserted(content) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const { data, error } = await admin
      .from("chat_messages")
      .select("id, room_id, user_id, content, reply_to_id")
      .eq("room_id", ROOM_ID)
      .eq("user_id", userId)
      .eq("content", content)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`insert timeout: ${content}`);
}

async function main() {
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error) throw created.error;
  userId = created.data.user.id;

  const profile = await admin.from("profiles").upsert({
    id: userId,
    nickname: `qa-giphy-${stamp.slice(-6)}`,
    team_id: 2002,
  });
  if (profile.error) throw profile.error;

  const authClient = createClient(SUPABASE_URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signedIn = await authClient.auth.signInWithPassword({ email, password });
  if (signedIn.error || !signedIn.data.session) throw signedIn.error ?? new Error("sign-in failed");
  const session = signedIn.data.session;

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH
      ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(
    ([accessToken, refreshToken]) => {
      sessionStorage.setItem("kbo-pending-session", JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
      }));
    },
    [session.access_token, session.refresh_token],
  );

  const page = await context.newPage();
  const giphyRequests = [];
  await page.route("https://api.giphy.com/v1/gifs/**", (route) => {
    // Keep only the endpoint: never retain API keys or complete request URLs.
    giphyRequests.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            id: ROOT_GIF_ID,
            title: "QA root GIF",
            images: { fixed_height: { url: longPickerUrl(ROOT_GIF_ID), width: "320", height: "240" } },
          },
          {
            id: REPLY_GIF_ID,
            title: "QA reply GIF",
            images: { fixed_height: { url: longPickerUrl(REPLY_GIF_ID), width: "320", height: "240" } },
          },
        ],
      }),
    });
  });
  await page.route("https://media*.giphy.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/svg+xml",
    body: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"320\" height=\"240\"><rect width=\"320\" height=\"240\" fill=\"#ff453a\"/></svg>",
  }));

  await page.goto(`${BASE_URL}/games/${GAME_ID}?chatDebug=1`, { waitUntil: "domcontentloaded" });
  const gifButton = page.locator('button[aria-label="GIF"]:visible').first();
  await gifButton.waitFor({ state: "visible" });

  const composer = gifButton.locator('xpath=ancestor::*[@data-composer="game-chat"][1]');
  const inputBox = await composer.locator('textarea[name="chat-message"]').boundingBox();
  const gifButtonBox = await gifButton.boundingBox();
  const sendButtonBox = await composer.locator("button:has(svg.lucide-send)").boundingBox();
  const centerY = (box) => box.y + box.height / 2;
  assert(
    inputBox && gifButtonBox && sendButtonBox
      && Math.abs(centerY(inputBox) - centerY(gifButtonBox)) <= 1
      && Math.abs(centerY(inputBox) - centerY(sendButtonBox)) <= 1,
    "작성창 GIF·입력·전송 버튼 중앙 정렬",
  );

  await gifButton.click();
  await page.getByAltText("QA root GIF").waitFor({ state: "visible", timeout: 10_000 });
  assert(
    giphyRequests.length === 1 && giphyRequests[0] === "/v1/gifs/trending",
    "피커 열기만으로 GIF 표시 — 추가 클릭 없이 Trending 1회",
  );
  await page.getByAltText("QA root GIF").click();
  const root = await waitForInserted(canonicalUrl(ROOT_GIF_ID));
  insertedIds.push(root.id);
  assert(root.reply_to_id === null, "일반 GIF 메시지 actual insert");
  assert(root.content.length <= 120, `일반 canonical URL ${root.content.length}자`);

  const rootImage = page.locator(`img[alt="GIPHY GIF"][src="${canonicalUrl(ROOT_GIF_ID)}"]`);
  await rootImage.waitFor({ state: "visible" });
  const rootMessage = rootImage.locator("xpath=ancestor::*[@data-chat-msg][1]");
  await rootMessage.getByLabel("답글").click();
  await gifButton.click();
  await page.getByAltText("QA reply GIF").waitFor({ state: "visible", timeout: 10_000 });
  assert(
    giphyRequests.length === 2 && giphyRequests[1] === "/v1/gifs/trending",
    "답글 피커도 열기만으로 GIF 표시 — Trending 1회 추가",
  );
  const gifSearch = page.getByPlaceholder("GIF 검색...");
  await gifSearch.fill("승리");
  // Exceed the shared 700ms debounce to catch accidental game-chat typeahead.
  await page.waitForTimeout(800);
  assert(giphyRequests.length === 2, "게임챗 검색어 입력만으로는 추가 호출 없음");
  await page.getByAltText("QA reply GIF").waitFor({ state: "visible" });
  const searchResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/v1/gifs/search");
  await gifSearch.press("Enter");
  await searchResponse;
  assert(
    giphyRequests.length === 3 && giphyRequests[2] === "/v1/gifs/search",
    "Enter로 검색 1회 호출",
  );
  await page.getByAltText("QA reply GIF").click();

  const reply = await waitForInserted(canonicalUrl(REPLY_GIF_ID));
  insertedIds.push(reply.id);
  assert(reply.reply_to_id === root.id, "1-depth GIF 답글 actual insert");
  assert(reply.content.length <= 120, `답글 canonical URL ${reply.content.length}자`);

  const replyImage = page.locator(`img[alt="GIPHY GIF"][src="${canonicalUrl(REPLY_GIF_ID)}"]`);
  await replyImage.waitFor({ state: "visible" });
  const box = await replyImage.boundingBox();
  assert(box && box.width <= 160 && box.height <= 120, `답글 GIF 렌더 ${box?.width}×${box?.height}px`);
}

async function cleanup() {
  if (insertedIds.length > 0) {
    const rows = await admin.from("chat_messages").delete().in("id", [...insertedIds].reverse());
    if (rows.error) console.error("cleanup chat rows:", rows.error.message);
  }
  if (userId) {
    await admin.from("profiles").delete().eq("id", userId);
    const hardDeleted = await admin.auth.admin.deleteUser(userId);
    if (hardDeleted.error) {
      const softDeleted = await admin.auth.admin.deleteUser(userId, true);
      if (softDeleted.error) console.error("cleanup auth user:", softDeleted.error.message);
    }
  }
  if (browser) await browser.close();
}

let ok = false;
try {
  await main();
  ok = true;
  console.log("\n✓ gamechat GIPHY UI smoke PASSED");
} catch (error) {
  console.error("\n✗ gamechat GIPHY UI smoke FAILED:", error);
} finally {
  await cleanup();
}
process.exit(ok ? 0 : 1);
