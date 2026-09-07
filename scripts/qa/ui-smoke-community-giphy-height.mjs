#!/usr/bin/env node
/**
 * Live PostDetail + CommentSheet GIPHY height smoke (reviewer execution).
 * No API/UI mocks, no supplied account, no credentials in argv or reports.
 * Creates one dedicated user/photo post; finally removes and verifies both.
 * Chromium viewport coverage is NOT real iOS keyboard/rotation/PWA QA.
 * Usage: npm run qa:ui:community-giphy-height -- --base-url=https://keubo.fan
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { expect } from "@playwright/test";
import { SUPABASE_URL, ANON, SERVICE_ROLE, REF, BASE } from "./_env.mjs";

const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const target = new URL(option("base-url", BASE));
if (target.username || target.password || target.search || target.hash || !["https:", "http:"].includes(target.protocol)) {
  throw new Error("Use a credential-free HTTP(S) origin for --base-url");
}
const base = target.origin;
const output = resolve(option("out", "state/qa/community-giphy-height.json"));
const viewports = [
  { width: 390, height: 844 }, // 480px upper clamp
  { width: 390, height: 667 }, // 70dvh
  { width: 390, height: 450 }, // 320px lower clamp, not a real keyboard
  { width: 844, height: 390 }, // short landscape viewport cap
];
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
const report = { target: base, scope: "live Chromium only; real-device and 429 closure excluded", boot: [], provider: [], measurements: [], cleanup: {}, passed: false };
let userId;
let postId;
let browser;
let userCreationAttempted = false;
let stage = "setup";
let checksPassed = false;
const requireThat = (condition, code) => {
  if (!condition) { const error = new Error(code); error.qaCode = code; throw error; }
};

async function seed() {
  const suffix = randomBytes(6).toString("hex");
  const email = `qa-gifheight-${suffix}@keubo.fan`;
  const password = randomBytes(24).toString("base64url");
  userCreationAttempted = true;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa: "community-giphy-height" } });
  requireThat(!created.error && created.data.user, "create_user_failed");
  userId = created.data.user.id;
  const profile = await admin.from("profiles").insert({ id: userId, nickname: `qa${suffix.slice(0, 8)}`, team_id: 2002, favorite_players: [] });
  requireThat(!profile.error, "create_profile_failed");
  const marker = `QAGIF-${suffix.slice(0, 6)}`;
  const post = await admin.from("posts").insert({
    title: marker, content: marker, author_id: userId, board_type: "team", board_id: "doosan",
    content_type: "photo", team_tags: ["doosan"], image_urls: [`${base}/community-cover.jpg`],
    is_hidden: false, comment_count: 0, like_count: 0,
  }).select("id").single();
  requireThat(!post.error && post.data, "create_post_failed");
  postId = post.data.id;
  const client = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const signed = await client.auth.signInWithPassword({ email, password });
  requireThat(!signed.error && signed.data.session, "sign_in_failed");
  return { session: signed.data.session, marker };
}

async function authenticatedContext(session) {
  const context = await browser.newContext({ viewport: viewports[0] });
  // Same cookie/localStorage bootstrap as the maintained comment-crud smoke.
  // Values stay in this process and structured Playwright arguments, never shell text.
  const key = `sb-${REF}-auth-token`;
  const value = JSON.stringify(session);
  await context.addCookies([{ name: key, value: `base64-${Buffer.from(value).toString("base64")}`, domain: target.hostname,
    path: "/", httpOnly: false, secure: target.protocol === "https:", sameSite: "Lax", expires: session.expires_at }]);
  await context.addInitScript(({ key, value, access, refresh }) => {
    localStorage.setItem(key, value);
    sessionStorage.setItem("kbo-pending-session", JSON.stringify({ access_token: access, refresh_token: refresh }));
  }, { key, value, access: session.access_token, refresh: session.refresh_token });
  return context;
}

async function measure(picker) {
  return picker.evaluate((root) => {
    const grid = root.querySelector(".overflow-y-auto");
    const search = root.querySelector('input[placeholder="GIF 검색..."]');
    const handle = root.querySelector(".cursor-grab");
    const close = handle?.querySelector("button");
    const attribution = [...root.querySelectorAll("span")].find((el) => el.textContent === "Powered by GIPHY");
    if (!grid || !search || !handle || !close || !attribution) return { ready: false };
    const vv = window.visualViewport;
    const clip = { left: vv?.offsetLeft ?? 0, top: vv?.offsetTop ?? 0,
      right: (vv?.offsetLeft ?? 0) + (vv?.width ?? innerWidth), bottom: (vv?.offsetTop ?? 0) + (vv?.height ?? innerHeight) };
    // Include clipping ancestors: viewport-only checks miss a clipped CommentSheet.
    for (let el = root; el; el = el.parentElement) {
      const style = getComputedStyle(el), r = el.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { clip.top = Math.max(clip.top, r.top); clip.bottom = Math.min(clip.bottom, r.bottom); }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { clip.left = Math.max(clip.left, r.left); clip.right = Math.min(clip.right, r.right); }
    }
    const inClip = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= clip.top - 1 && r.bottom <= clip.bottom + 1 && r.left >= clip.left - 1 && r.right <= clip.right + 1; };
    const rect = root.getBoundingClientRect(), gr = grid.getBoundingClientRect();
    const tiles = [...grid.querySelectorAll("img")];
    const visible = tiles.filter((img) => { const r = img.getBoundingClientRect(); return r.bottom > Math.max(gr.top, clip.top) && r.top < Math.min(gr.bottom, clip.bottom); });
    const loaded = visible.filter((img) => img.complete && img.naturalWidth > 0);
    const styles = getComputedStyle(document.documentElement);
    // These are desktop Chromium viewports, with zero device safe-area env insets.
    const rem = parseFloat(styles.fontSize);
    const topInset = parseFloat(styles.getPropertyValue("--safe-area-inset-top")) || 0;
    const bottomInset = parseFloat(styles.getPropertyValue("--safe-area-inset-bottom")) || 0;
    const expectedHeight = Math.min(Math.max(320, Math.min(0.7 * innerHeight, 480)), Math.max(160, (vv?.height ?? innerHeight) - 8 * rem - topInset - bottomInset));
    return { ready: true, height: rect.height, expectedHeight, heightMatches: Math.abs(rect.height - expectedHeight) <= 2,
      viewport: { width: innerWidth, height: innerHeight }, gridHeight: gr.height, gridScrollHeight: grid.scrollHeight,
      gridOverflowY: getComputedStyle(grid).overflowY, tileCount: tiles.length, visibleTiles: visible.length, loadedVisibleTiles: loaded.length,
      controlsUnclipped: [search, handle, close, attribution].every(inClip), pageScrollY: scrollY };
  });
}

async function inspectSurface(page, surface, open) {
  stage = `${surface}:entry`;
  await page.setViewportSize(viewports[0]);
  await open();
  const gif = page.locator('button[aria-label="GIF"]:visible');
  await expect(gif).toHaveCount(1);
  await expect(gif).toBeEnabled();
  const requestStart = report.provider.length;
  await gif.click();
  const picker = page.locator('div[style*="clamp(320px"]');
  await expect(picker).toHaveCount(1);
  for (const viewport of viewports) {
    stage = `${surface}:${viewport.width}x${viewport.height}`;
    await page.setViewportSize(viewport);
    await expect.poll(async () => {
      const m = await measure(picker);
      report.lastObservation = { surface, ...m };
      return m.ready && m.heightMatches && m.controlsUnclipped && m.gridHeight > 0 && m.loadedVisibleTiles > 0;
    }, { timeout: 20_000, message: `${surface}: loaded, correctly sized, unclipped picker` }).toBe(true);
    const before = await measure(picker);
    requireThat(before.gridScrollHeight > before.gridHeight, "grid_does_not_overflow");
    requireThat(["auto", "scroll"].includes(before.gridOverflowY), "grid_not_scrollable");
    requireThat(await picker.getByText("크보팬 인기 GIF", { exact: false }).count() === 0, "gamechat_only_ui_in_community");
    const grid = picker.locator(".overflow-y-auto");
    // Real wheel input must move the list without moving the page or controls.
    const searchY = (await picker.getByPlaceholder("GIF 검색...").boundingBox()).y;
    await grid.hover();
    await page.mouse.wheel(0, 180);
    await expect.poll(() => grid.evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBeGreaterThan(0);
    const after = await measure(picker);
    requireThat(Math.abs(after.pageScrollY - before.pageScrollY) <= 1, "page_scrolled_with_grid");
    requireThat(Math.abs((await picker.getByPlaceholder("GIF 검색...").boundingBox()).y - searchY) <= 1, "search_moved_with_grid");
    requireThat(after.controlsUnclipped, "controls_clipped_after_scroll");
    await grid.evaluate((el) => { el.scrollTop = 0; });
    // Picker-only evidence: no profile, surrounding feed or session payload.
    const screenshot = resolve(dirname(output), `${surface}-${viewport.width}x${viewport.height}.png`);
    await picker.screenshot({ path: screenshot });
    report.measurements.push({ surface, ...before, internalScrollVerified: true, screenshot });
  }
  const requests = report.provider.slice(requestStart);
  requireThat(requests.length === 1 && requests[0].endpoint === "trending" && requests[0].status === 200, "community_request_contract_failed");
  await picker.locator(".cursor-grab button").click();
  await expect(picker).toHaveCount(0);
}

async function cleanup() {
  const errors = [];
  const attempt = async (name, task) => { try { requireThat(await task(), name); } catch { errors.push(name); } };
  if (userCreationAttempted && !userId) errors.push("user_creation_outcome_unknown");
  if (userId) {
    // The id is from this run's newly created user, never supplied by the caller.
    // Also covers a post insert that succeeded but lost its response.
    await attempt("delete_posts", async () => !(await admin.from("posts").delete().eq("author_id", userId)).error);
    await attempt("delete_profile", async () => !(await admin.from("profiles").delete().eq("id", userId)).error);
    await attempt("delete_user", async () => !(await admin.auth.admin.deleteUser(userId)).error);
    await attempt("verify_posts_gone", async () => {
      const r = await admin.from("posts").select("id", { count: "exact", head: true }).eq("author_id", userId);
      return !r.error && r.count === 0;
    });
    await attempt("verify_profile_gone", async () => { const r = await admin.from("profiles").select("id").eq("id", userId).maybeSingle(); return !r.error && !r.data; });
    await attempt("verify_user_gone", async () => { const r = await admin.auth.admin.getUserById(userId); return !r.data?.user && r.error?.status === 404; });
  }
  report.cleanup = { verified: errors.length === 0, errors };
}

const pendingResponses = new Set();
try {
  mkdirSync(dirname(output), { recursive: true });
  const { session, marker } = await seed();
  browser = await chromium.launch({ headless: !process.argv.includes("--headed"), executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await authenticatedContext(session);
  const page = await context.newPage();
  page.on("response", (response) => {
    const url = new URL(response.url());
    // Keep only fixed endpoint names/status and profile-presence booleans.
    // Never serialize request URLs, tokens, profile payloads or error messages.
    if (url.hostname === "api.giphy.com") report.provider.push({ endpoint: url.pathname.split("/").at(-1), status: response.status() });
    if (url.origin === base && url.pathname === "/api/game-chat/popular-gifs") report.provider.push({ endpoint: "popular-gifs", status: response.status() });
    if (url.origin === base && url.pathname === "/api/me/boot") {
      // This endpoint requires Bearer, not cookies. Observe the app's request;
      // a separate cookie-only diagnostic fetch would legitimately return 401.
      const hasBearer = /^Bearer \S+/.test(response.request().headers().authorization ?? "");
      const work = response.json().then((body) => report.boot.push({ status: response.status(), hasBearer, hasProfile: !!body.profile,
        idMatches: body.profile?.id === userId, hasNickname: !!body.profile?.nickname, hasTeam: !!body.profile?.team_id })).catch(() => report.boot.push({ status: response.status(), hasBearer, unreadable: true }));
      pendingResponses.add(work);
      void work.finally(() => pendingResponses.delete(work));
    }
  });
  await inspectSurface(page, "post-detail", async () => {
    await page.goto(`${base}/community/teams/doosan/posts/${postId}`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => report.boot.some((r) => r.status === 200 && r.hasBearer && r.idMatches && r.hasNickname && r.hasTeam), { timeout: 20_000 }).toBe(true);
    await expect(page.locator('[data-composer="postdetail"]')).toBeVisible();
  });
  await inspectSurface(page, "comment-sheet", async () => {
    const bootStart = report.boot.length;
    await page.goto(`${base}/community/all-photos`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => report.boot.slice(bootStart).some((r) => r.status === 200 && r.hasBearer && r.idMatches && r.hasNickname && r.hasTeam), { timeout: 20_000 }).toBe(true);
    // Open only our short, unique photo caption (the feed's actual CommentSheet action).
    await page.getByText(marker, { exact: true }).click();
    await expect(page.locator('[data-comment-scroll="true"]')).toBeVisible();
  });
  checksPassed = true;
} catch (error) {
  // Playwright exceptions can contain serialized arguments. Do not print them.
  report.failure = { stage, type: error?.name === "TimeoutError" ? "TimeoutError" : "CheckFailed",
    ...(typeof error?.qaCode === "string" && /^[a-z_]+$/.test(error.qaCode) ? { code: error.qaCode } : {}) };
} finally {
  if (browser) await browser.close().catch(() => {});
  await Promise.allSettled([...pendingResponses]);
  await cleanup();
  report.passed = checksPassed && report.cleanup.verified;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`[community-giphy-height] ${report.passed ? "PASS" : "FAIL"}; measurements=${report.measurements.length}; cleanup=${report.cleanup.verified ? "verified" : "FAILED"}; report=${output}`);
}
process.exitCode = report.passed ? 0 : 1;
