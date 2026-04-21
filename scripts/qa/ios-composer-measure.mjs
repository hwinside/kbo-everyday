#!/usr/bin/env node
/**
 * iOS Composer 실측 — 삼순이 GO/NO-GO용
 *
 * Playwright WebKit(iOS Safari와 동일 엔진) + iPhone 14 preset.
 * 로그인 세션을 주입해 PostDetail / CommentSheet composer가 키보드 열림 시
 * visual viewport 하단에 딱 붙는지(= Δ ≤ 30px) 자동 측정.
 *
 * 측정 경로: .env.local → Supabase Admin → 일회용 유저 생성 → 시드 포스트
 * 생성 → webkit + iPhone 14 → input.focus() + visualViewport resize 이벤트
 * 강제 발화로 키보드 오픈 상태 에뮬 → composer boundingBox 측정.
 *
 * 한계: iOS input accessory(자동완성) bar는 에뮬 불가 — React 로직 경로만 검증.
 *
 * 사용:
 *   node scripts/qa/ios-composer-measure.mjs --base-url=http://localhost:3000
 *   node scripts/qa/ios-composer-measure.mjs --base-url=https://keubo.fan
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPABASE_URL, ANON, SERVICE_ROLE, REF, BASE } from "./_env.mjs";

const { webkit, devices } = playwright;
const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(__dirname, "../../tmp/qa-ios-composer");
mkdirSync(SHOT_DIR, { recursive: true });

const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split("=")[1] : d;
};
const BASE_URL = arg("base-url", BASE || "http://localhost:3000");
const iPhone = devices["iPhone 14"];

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const STAMP = Date.now().toString(36);
const email = `qa-ios-${STAMP}@keubo.fan`;
const pw = "QaTest!" + STAMP;
const cleanupIds = [];
const results = [];
const report = (name, pass, details) => {
  results.push({ name, pass, details });
  console.log(`${pass ? "✅ PASS" : "❌ FAIL"}  ${name}`);
  if (details) console.log(`       ${details}`);
};

async function signIn() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pw }),
  });
  if (!r.ok) throw new Error(`sign-in failed: ${r.status}`);
  return r.json();
}

async function seed() {
  const { data: u, error } = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (error) throw error;
  cleanupIds.push(u.user.id);
  await admin.from("profiles").insert({ id: u.user.id, nickname: `qaios${STAMP.slice(-6)}`, team_id: 2002 });
  const sess = await signIn();

  const { data: post, error: pErr } = await admin
    .from("posts")
    .insert({
      title: `[QA-IOS-${STAMP}] composer`,
      content: "ios composer measurement",
      author_id: u.user.id,
      board_type: "team",
      board_id: "doosan",
      content_type: "general",
      comment_count: 0,
      like_count: 0,
    })
    .select()
    .single();
  if (pErr) throw pErr;

  // one photo post for comment sheet (content_type=photo).
  // Reuse a real Supabase storage URL from an existing photo post (next.config
  // only allows lbmbdjgsnenqjwjotoei.supabase.co host).
  let reuseUrl = null;
  const { data: existingPhoto } = await admin
    .from("posts")
    .select("image_urls")
    .eq("content_type", "photo")
    .not("image_urls", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingPhoto?.image_urls?.length) reuseUrl = existingPhoto.image_urls[0];

  const { data: photo, error: photoErr } = await admin
    .from("posts")
    .insert({
      title: `[QA-IOS-${STAMP}] photo`,
      content: "ios photo",
      author_id: u.user.id,
      board_type: "team",
      board_id: "doosan",
      content_type: "photo",
      image_urls: reuseUrl ? [reuseUrl] : [],
      comment_count: 0,
      like_count: 0,
    })
    .select()
    .single();
  if (photoErr) console.warn("photo seed failed:", photoErr.message);

  return { user: u.user, sess, post, photo };
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
  const secure = BASE_URL.startsWith("https");
  await ctx.addCookies([
    {
      name: cookieName,
      value: cookieVal,
      domain: host,
      path: "/",
      httpOnly: false,
      secure,
      sameSite: "Lax",
      expires: session.expires_at,
    },
  ]);
  await ctx.addInitScript(
    ([k, v]) => {
      try { window.localStorage.setItem(k, v); } catch {}
    },
    [cookieName, ls],
  );
}

async function simulateKeyboard(page, kbPx = 336) {
  await page.evaluate((px) => {
    if (!window.visualViewport) return;
    const realH = window.visualViewport.height;
    Object.defineProperty(window.visualViewport, "height", { configurable: true, get: () => Math.max(200, realH - px) });
    window.visualViewport.dispatchEvent(new Event("resize"));
  }, kbPx);
}

async function measureInput(page, input, label, { kbPx = 336, screenshot = true } = {}) {
  const before = await page.evaluate(() => ({ vvH: window.visualViewport.height, vvT: window.visualViewport.offsetTop, innerH: window.innerHeight }));
  const boxBefore = await input.boundingBox();
  await input.focus();
  await page.waitForTimeout(250);
  await simulateKeyboard(page, kbPx);
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({ vvH: window.visualViewport.height, vvT: window.visualViewport.offsetTop, innerH: window.innerHeight }));
  const boxAfter = await input.boundingBox();
  const vvBottom = after.vvH + (after.vvT || 0);
  const composerBottom = boxAfter ? boxAfter.y + boxAfter.height : null;
  const delta = composerBottom != null ? Math.abs(vvBottom - composerBottom) : Infinity;
  console.log(`  ${label} before: vv=${before.vvH}/${before.vvT} box=y${boxBefore?.y.toFixed(0)}+${boxBefore?.height.toFixed(0)}`);
  console.log(`  ${label} after : vv=${after.vvH}/${after.vvT} box=y${boxAfter?.y.toFixed(0)}+${boxAfter?.height.toFixed(0)}`);
  report(
    `${label}: composer hugs vv bottom (Δ≤30px)`,
    delta <= 30,
    `vvBottom=${vvBottom.toFixed(1)} composerBottom=${composerBottom?.toFixed(1)} Δ=${delta.toFixed(1)} kbPx=${kbPx}`,
  );
  if (boxBefore && boxAfter) {
    const xJump = Math.abs(boxBefore.x - boxAfter.x);
    report(`${label}: composer x stable (<2px)`, xJump < 2, `xJump=${xJump.toFixed(1)}`);
  }
  if (screenshot) await page.screenshot({ path: resolve(SHOT_DIR, `${label}-focused.png`) });
  return { before, after, boxAfter, delta };
}

async function cleanup() {
  for (const id of cleanupIds) {
    try { await admin.auth.admin.deleteUser(id); } catch {}
  }
}

(async () => {
  console.log(`Base URL: ${BASE_URL}`);
  let seeded;
  try {
    seeded = await seed();
    console.log(`user=${seeded.user.id.slice(0, 8)} post=${seeded.post.id} photo=${seeded.photo?.id}`);
  } catch (e) {
    console.error("seed failed:", e.message);
    process.exit(2);
  }

  const browser = await webkit.launch({ headless: true });
  const ctx = await browser.newContext({ ...iPhone });
  await injectSession(ctx, seeded.sess);

  // 1) PostDetail
  {
    const page = await ctx.newPage();
    const postPath = `/community/teams/${seeded.post.board_id}/posts/${seeded.post.id}`;
    try {
      await page.goto(`${BASE_URL}${postPath}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);
      const input = await page.$("input[placeholder*='댓글']");
      if (!input) {
        report("PostDetail: composer input", false, "not found");
        await page.screenshot({ path: resolve(SHOT_DIR, "PostDetail-missing.png") });
      } else {
        await measureInput(page, input, "PostDetail");
      }
    } catch (e) {
      report("PostDetail", false, e.message);
    } finally {
      await page.close();
    }
  }

  // 3) GameChat via /games/<gameId> (default tab = kgwan contains GameChat)
  {
    const page = await ctx.newPage();
    try {
      // Use a known live game from src/lib/constants/games.ts so GameChat actually mounts
      // (scheduled games hide the chat until T-12h). --game-id override available.
      const gameIdOverride = arg("game-id", "20260328-LG-DS");
      const firstGameHref = `/games/${gameIdOverride}`;
      {
        await page.goto(`${BASE_URL}${firstGameHref}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(3500);
        const input = await page.$("input[placeholder*='메시지'], input[placeholder*='채팅']");
        if (!input) {
          report("GameChat: composer input", false, "not found (maybe not on kgwan tab)");
          await page.screenshot({ path: resolve(SHOT_DIR, "GameChat-missing.png") });
        } else {
          await measureInput(page, input, "GameChat");
        }
      }
    } catch (e) {
      report("GameChat", false, e.message);
    } finally {
      await page.close();
    }
  }

  // 2) CommentSheet via all-photos feed
  {
    const page = await ctx.newPage();
    try {
      // Use the seeded team's photo feed directly (faster, guaranteed photo post).
      await page.goto(`${BASE_URL}/community/teams/${seeded.post.board_id}?tab=photos`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(4500);
      // find the comment button. photo cards normally carry message-circle lucide icon.
      // Try several selectors (lucide-react injects class lucide-message-circle).
      const btnCandidates = [
        "button[aria-label*='댓글']",
        "button:has(svg.lucide-message-circle)",
        "button:has(svg.lucide-MessageCircle)",
        "button.flex:has(svg)", // last-resort: any svg button
      ];
      let btn = null;
      for (const sel of btnCandidates) {
        const candidates = await page.$$(sel);
        // pick the one whose svg width/height ~ 20 (MessageCircle size=20)
        for (const c of candidates) {
          const hasMsg = await c.evaluate((el) => !!el.querySelector('svg.lucide-message-circle'));
          if (hasMsg) { btn = c; break; }
        }
        if (btn) { console.log(`  CommentSheet: comment btn via ${sel}`); break; }
      }
      if (!btn) {
        report("CommentSheet: find comment button on all-photos", false, "no candidate matched");
        await page.screenshot({ path: resolve(SHOT_DIR, "CommentSheet-no-button.png") });
      } else {
        await btn.click();
        await page.waitForTimeout(900);
        const input = await page.$("input[placeholder*='댓글']");
        if (!input) {
          report("CommentSheet: sheet input mounted", false, "sheet opened but input missing");
          await page.screenshot({ path: resolve(SHOT_DIR, "CommentSheet-opened-no-input.png") });
        } else {
          await measureInput(page, input, "CommentSheet");
        }
      }
    } catch (e) {
      report("CommentSheet", false, e.message);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  await cleanup();

  const failed = results.filter((r) => !r.pass);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} PASS`);
  console.log(`Screenshots: ${SHOT_DIR}`);
  writeFileSync(resolve(SHOT_DIR, "report.json"), JSON.stringify({ base: BASE_URL, at: new Date().toISOString(), results }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
})();
