#!/usr/bin/env node
/**
 * End-User QA: 콜렉터 글 작성자 배지 = 글 올리는 팀 (#1124)
 *
 * 전용 테스트 계정을 새로 만들어 실제 로그인 세션으로 Production 상세 페이지를 열고,
 * 작성자 헤더에 찍힌 팀 배지 텍스트를 눈에 보이는 그대로 읽는다.
 *
 * 대상 3건
 *   #4333 김도영(KIA)   — 백필 대상, LG → KIA 여야 한다 (사고 재현 글)
 *   #4095 손성빈(롯데)  — 백필 대상, LG → 롯데
 *   #2107 데이비슨      — 백필 제외(배포 이전 글). 게시 당시 NC 그대로 유지돼야 한다
 *
 * 사용법:
 *   node scripts/qa/ui-smoke-collector-author-team.mjs
 *   node scripts/qa/ui-smoke-collector-author-team.mjs --base-url=https://keubo.fan --headed
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
const BASE_URL = process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] || BASE;

/** 기대값 — 배지에 이 팀 shortName 이 보여야 한다. */
const CASES = [
  { id: 4333, path: "/community/players/52605/posts/4333", want: "KIA", note: "백필 대상(사고 재현 글, 김도영)" },
  { id: 4095, path: "/community/players/51528/posts/4095", want: "롯데", note: "백필 대상(손성빈)" },
  { id: 2107, path: "/community/players/54944/posts/2107", want: "NC", note: "백필 제외 — 게시 당시 팀 보존(데이비슨)" },
];
const ALL_TEAMS = ["LG", "두산", "KT", "SSG", "NC", "KIA", "롯데", "삼성", "한화", "키움"];

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
let passCount = 0;
let failCount = 0;
const check = (name, cond, msg) => {
  console.log(`  ${cond ? "✅" : "❌"}  ${name}${cond || !msg ? "" : `  ${msg}`}`);
  cond ? passCount++ : failCount++;
};

const STAMP = Date.now().toString(36);
const email = `qa-collector-${STAMP}@keubo.fan`;
const pw = "QaTest!" + STAMP;
const cleanupIds = [];

async function seedUser() {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: pw,
    email_confirm: true,
  });
  if (error) throw error;
  cleanupIds.push(data.user.id);
  const { error: pErr } = await admin.from("profiles").insert({
    id: data.user.id,
    nickname: "qacol" + STAMP.slice(0, 8),
    team_id: 2002, // 일부러 대상 3건 어느 팀과도 겹치지 않는 값 — 뷰어 팀이 배지에 새는지 함께 본다
  });
  if (pErr) throw new Error("profile insert failed: " + pErr.message);

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
      domain: new URL(BASE_URL).hostname,
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
  log("base:", BASE_URL);
  const session = await seedUser();
  log("test user ready:", session.user.id.slice(0, 8));

  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
  await injectSession(ctx, session);
  const page = await ctx.newPage();

  for (const c of CASES) {
    log(`--- #${c.id} ${c.note}`);
    await page.goto(BASE_URL + c.path, { waitUntil: "networkidle", timeout: 45000 });
    const header = page.locator("[data-community-author-header]").first();
    await header.waitFor({ state: "visible", timeout: 20000 }).catch(() => {});

    const visible = await header.isVisible().catch(() => false);
    check(`#${c.id} 작성자 헤더 렌더`, visible);
    if (!visible) continue;

    const text = (await header.innerText()).replace(/\s+/g, " ").trim();
    log(`   header: "${text}"`);

    // 기대 팀이 "<팀> 팬" 형태로 보인다.
    check(`#${c.id} 배지가 "${c.want} 팬"`, text.includes(`${c.want} 팬`), `실제: "${text}"`);
    // 다른 구단 이름이 배지로 새지 않는다 — 특히 봇 프로필 팀(LG).
    const leaked = ALL_TEAMS.filter((t) => t !== c.want && text.includes(`${t} 팬`));
    check(`#${c.id} 다른 구단 팬 배지 없음`, leaked.length === 0, `누출: ${leaked.join(",")}`);

    await page.screenshot({ path: `${SHOT_DIR}/collector-author-${c.id}.png` });
  }

  // 피드에서도 같은 값이 보이는지(상세만 고쳐진 게 아님) — 김도영 선수 게시판 목록.
  log("--- 선수 게시판 피드");
  await page.goto(`${BASE_URL}/community/players/52605`, { waitUntil: "networkidle", timeout: 45000 });
  const feedText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  check("피드에 LG 팬 배지 없음(김도영 게시판)", !feedText.includes("LG 팬"), "피드에 LG 팬 잔존");
  await page.screenshot({ path: `${SHOT_DIR}/collector-author-feed.png`, fullPage: false });

  await browser.close();
  console.log(`\n${failCount === 0 ? "PASS" : "FAIL"} — ${passCount} passed, ${failCount} failed`);
  return failCount === 0;
}

async function teardown() {
  for (const uid of cleanupIds) {
    try {
      await admin.from("profiles").delete().eq("id", uid);
      await admin.auth.admin.deleteUser(uid);
      log("cleaned up test user", uid.slice(0, 8));
    } catch (e) {
      console.error("cleanup failed:", e.message);
    }
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
