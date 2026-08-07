#!/usr/bin/env node
/**
 * End-User QA: 콜렉터 글 작성자 배지 = 글 올리는 팀 (#1124)
 *
 * 전용 테스트 계정을 새로 만들어 실제 로그인 세션으로 Production 상세/피드를 열고,
 * 작성자 헤더에 찍힌 팀 배지 텍스트를 눈에 보이는 그대로 읽는다.
 *
 * 대상 3건
 *   #4333 김도영(KIA)   — 백필 대상, LG → KIA 여야 한다 (사고 재현 글)
 *   #4095 손성빈(롯데)  — 백필 대상, LG → 롯데
 *   #2107 데이비슨      — 백필 제외(배포 이전 글). 게시 당시 NC 그대로 유지돼야 한다
 *
 * fail-close 원칙
 *   · 로그인 상태를 **앱 레벨에서** 확인하지 못하면 그 자리에서 실패한다.
 *     (토큰 주입만 확인하면 비로그인 공개 페이지로도 전부 PASS 한다 — 검출력 0)
 *   · 피드 검사는 게시판 탭을 열고 **그 글 카드를 특정해서** 본다.
 *     (body 전체에서 "LG 팬" 부재만 보면 카드가 안 그려져도 PASS 한다)
 *   · 테스트 계정 정리는 삭제 반환 오류와 잔존 0을 모두 확인한다. 잔존이 있으면 exit 1.
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

/** 기대값 — 배지에 이 팀 shortName 이 `"<팀> 팬"` 으로 보여야 한다. */
const CASES = [
  {
    id: 4333,
    playerId: "52605",
    want: "KIA",
    note: "백필 대상(사고 재현 글, 김도영)",
    // 피드에서 이 글 카드를 집어내는 본문 지문(제목 = 본문).
    feedText: "땀 흘리는 내 모습 멋있어",
    // 카드 경계가 어긋나 *다른 글* 헤더를 읽는 경우를 잡는 판별자.
    // (같은 게시판 상단 글도 "KIA 팬" 일 수 있어 팀명만으로는 구분이 안 된다)
    author: "짤콜렉터",
  },
  { id: 4095, playerId: "51528", want: "롯데", note: "백필 대상(손성빈)" },
  { id: 2107, playerId: "54944", want: "NC", note: "백필 제외 — 게시 당시 팀 보존(데이비슨)" },
];
const ALL_TEAMS = ["LG", "두산", "KT", "SSG", "NC", "KIA", "롯데", "삼성", "한화", "키움"];

/** 뷰어 프로필 팀 — 대상 3건 어느 팀과도 겹치지 않는 값이어야 뷰어 팀 누출을 잡는다. */
const VIEWER_TEAM_ID = 2002;

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
  return cond;
};

const STAMP = Date.now().toString(36);
const email = `qa-collector-${STAMP}@keubo.fan`;
const nickname = "qacol" + STAMP.slice(0, 8);
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
  const { error: pErr } = await admin
    .from("profiles")
    .insert({ id: data.user.id, nickname, team_id: VIEWER_TEAM_ID });
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

/**
 * 로그인 확인 — 토큰이 브라우저에 있는지(전제)와 **앱이 그 사용자로 렌더했는지**(본질)를 함께 본다.
 * 앱 레벨 확인이 없으면 비로그인 공개 페이지로도 아래 검사가 전부 통과해 검출력이 0이 된다.
 */
async function verifyLoggedIn(page, userId) {
  await page.goto(`${BASE_URL}/my`, { waitUntil: "networkidle", timeout: 45000 });

  const storedUid = await page.evaluate((ref) => {
    try {
      const raw = window.localStorage.getItem(`sb-${ref}-auth-token`);
      if (!raw) return null;
      return JSON.parse(raw)?.user?.id ?? null;
    } catch {
      return null;
    }
  }, REF);
  check("브라우저 세션 uid == 테스트 계정", storedUid === userId, `got ${storedUid}`);

  // 앱이 실제로 그 프로필을 읽어 렌더했는가 — 마이페이지 닉네임.
  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const renderedAsUser = body.includes(nickname);
  check("앱이 테스트 계정으로 렌더(마이페이지 닉네임)", renderedAsUser, `nickname "${nickname}" 미표시`);
  // 비로그인 화면이면 회원가입 CTA 가 뜬다 — 그게 보이면 로그인 실패다.
  check("비로그인 CTA 미노출", !body.includes("회원가입 / 로그인"));

  await page.screenshot({ path: `${SHOT_DIR}/collector-author-login.png` });
  return storedUid === userId && renderedAsUser;
}

/** 헤더 텍스트에서 기대 팀 배지 + 타팀 누출 부재를 함께 본다. */
function assertBadge(label, text, want) {
  check(`${label} 배지가 "${want} 팬"`, text.includes(`${want} 팬`), `실제: "${text}"`);
  const leaked = ALL_TEAMS.filter((t) => t !== want && text.includes(`${t} 팬`));
  check(`${label} 다른 구단 팬 배지 없음`, leaked.length === 0, `누출: ${leaked.join(",")}`);
}

async function main() {
  log("base:", BASE_URL);
  const session = await seedUser();
  log("test user ready:", session.user.id.slice(0, 8), nickname);

  const browser = await chromium.launch({ headless: !HEADED });
  try {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    await injectSession(ctx, session);
    const page = await ctx.newPage();

    // ── 0. 로그인 확인 (실패하면 이후 검사는 의미 없음 → 즉시 중단)
    log("--- 로그인 확인");
    if (!(await verifyLoggedIn(page, session.user.id))) {
      console.log("\n로그인 확인 실패 — 이후 검사는 검출력이 없으므로 중단합니다.");
      return false;
    }

    // ── 1. 상세 3건
    for (const c of CASES) {
      log(`--- 상세 #${c.id} ${c.note}`);
      await page.goto(`${BASE_URL}/community/players/${c.playerId}/posts/${c.id}`, {
        waitUntil: "networkidle",
        timeout: 45000,
      });
      const header = page.locator("[data-community-author-header]").first();
      await header.waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
      if (!check(`#${c.id} 작성자 헤더 렌더`, await header.isVisible().catch(() => false))) continue;

      const text = (await header.innerText()).replace(/\s+/g, " ").trim();
      log(`   header: "${text}"`);
      assertBadge(`#${c.id}`, text, c.want);
      await page.screenshot({ path: `${SHOT_DIR}/collector-author-${c.id}.png` });
    }

    // ── 2. 피드 — 게시판 탭을 열고 그 글 카드를 특정해서 본다.
    //    상세만 고쳐지고 피드가 옛값을 그리는 상태를 배제하기 위한 검사이므로,
    //    카드가 실제로 렌더됐다는 것 자체가 검사의 전제다(부재 = 실패).
    const feedCase = CASES[0];
    log(`--- 피드 #${feedCase.id} (선수 ${feedCase.playerId} 게시판 탭)`);
    await page.goto(`${BASE_URL}/community/players/${feedCase.playerId}`, {
      waitUntil: "networkidle",
      timeout: 45000,
    });
    await page.getByRole("button", { name: /게시판/ }).click();

    // 본문 지문으로 카드를 찾는다. 무한스크롤이라 나올 때까지 내린다.
    const anchor = page.getByText(feedCase.feedText, { exact: false }).first();
    for (let i = 0; i < 12 && !(await anchor.count()); i++) {
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(600);
    }
    if (check(`피드에 #${feedCase.id} 글 렌더`, (await anchor.count()) > 0, `"${feedCase.feedText}" 미노출`)) {
      // 그 글의 카드 경계를 조상으로 올라가며 찾는다.
      // ⚠️ 조상 탐색은 쉽게 여러 글의 공통조상을 잡는다(#1122 에서 실제로 거짓 RED 발생).
      // 그래서 "작성자 헤더를 정확히 1개 포함"을 경계 조건으로 강제하고,
      // 못 찾으면 그냥 통과시키지 않고 실패로 둠다(fail-close).
      const cardText = await anchor.evaluate((el) => {
        let node = el;
        for (let depth = 0; depth < 12 && node; depth++) {
          const headers = node.querySelectorAll?.("[data-community-author-header]") ?? [];
          if (headers.length === 1) return headers[0].innerText;
          if (headers.length > 1) return null; // 공통조상까지 올라갔다 — 경계 실패
          node = node.parentElement;
        }
        return null;
      });
      if (check(`피드 #${feedCase.id} 카드 경계 확보(작성자 헤더 1개)`, cardText != null)) {
        const t = cardText.replace(/\s+/g, " ").trim();
        log(`   card header: "${t}"`);
        // 읽은 헤더가 **그 글의 것**인지 먼저 못박는다. 이게 없으면 경계가 어긋나
        // 다른 글 헤더를 읽어도 팀명이 우연히 같아 GREEN 이 된다.
        check(`피드 #${feedCase.id} 헤더가 그 글의 작성자(${feedCase.author})`, t.includes(feedCase.author), `실제: "${t}"`);
        assertBadge(`피드 #${feedCase.id}`, t, feedCase.want);
      }
      await page.screenshot({ path: `${SHOT_DIR}/collector-author-feed-card.png` });
    }

    console.log(`\n${failCount === 0 ? "PASS" : "FAIL"} — ${passCount} passed, ${failCount} failed`);
    return failCount === 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * 정리 — fail-close. 삭제 반환 오류를 삼키지 않고, 삭제 후 auth/profile 잔존 0을 실제로 확인한다.
 * 잔존이 있으면 Production 에 QA 계정이 남는다는 뜻이라 실패로 처리한다.
 */
async function teardown() {
  let clean = true;
  for (const uid of cleanupIds) {
    const { error: pErr } = await admin.from("profiles").delete().eq("id", uid);
    if (pErr) {
      console.error(`  ❌ profile 삭제 실패 ${uid}: ${pErr.message}`);
      clean = false;
    }
    const { error: uErr } = await admin.auth.admin.deleteUser(uid);
    if (uErr) {
      console.error(`  ❌ auth 유저 삭제 실패 ${uid}: ${uErr.message}`);
      clean = false;
    }

    // postcondition — 진짜 사라졌는지 다시 읽어본다.
    const { data: prof } = await admin.from("profiles").select("id").eq("id", uid).maybeSingle();
    if (prof) {
      console.error(`  ❌ profile 잔존 ${uid}`);
      clean = false;
    }
    const { data: authUser } = await admin.auth.admin.getUserById(uid);
    if (authUser?.user) {
      console.error(`  ❌ auth 유저 잔존 ${uid}`);
      clean = false;
    }
    if (clean) log("cleaned up test user", uid.slice(0, 8));
  }
  return clean;
}

let ok = false;
let cleaned = false;
try {
  ok = await main();
} catch (e) {
  console.error("\n[ERROR]", e.message);
} finally {
  try {
    cleaned = await teardown();
  } catch (e) {
    console.error("[ERROR] teardown:", e.message);
    cleaned = false;
  }
}
if (!cleaned) console.error("테스트 계정 정리 실패 — Production 잔여물을 직접 확인하세요.");
process.exit(ok && cleaned ? 0 : 1);
