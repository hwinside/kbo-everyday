#!/usr/bin/env -S npx tsx
/**
 * 야잘알봇 앱 기능 안내 — End-User Level QA (#1344, 삼순 HOLD ③ "전용 계정 UI 증거").
 *
 * 실제 배포본(프리뷰/프로덕션)의 쪽지방 UI 에서 전용 테스트 계정으로 질문을 보내고,
 * 봇이 화면에 렌더한 답변 원문이 `PRODUCT_FEATURE_REGISTRY` 문구와 **완전 일치**하는지 본다.
 *
 *  - 하린아빠 개인/공유 계정 사용 금지(AGENTS.md P0) → 실행마다 전용 계정 생성 → 종료 시 삭제(postcondition 확인)
 *  - 스텁 종단 게이트(`genius-product-feature-guide.ts`)와 달리 여기서는 서버·DB·LLM 경로를 우회하지 않는다
 *  - 음성 1건(기록 질문)은 기능 안내 문구가 **나오면 안 된다**
 *
 * 사용: QA_BASE_URL=https://<preview>.vercel.app npx tsx scripts/qa/genius-product-feature-guide-ui-smoke.ts
 *   프리뷰 보호는 .env.local 의 VERCEL_PROTECTION_BYPASS_TOKEN 으로 우회(값은 출력하지 않는다).
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { mkdirSync } from "node:fs";
import { ANON, BASE, REF, SERVICE_ROLE, SUPABASE_URL } from "./_env.mjs";
import { productFeatureGuideAnswer, type ProductFeatureKey } from "../../src/lib/baseball-qa/pipeline";

const BASE_URL = process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] ?? BASE;
const BYPASS = process.env.VERCEL_PROTECTION_BYPASS_TOKEN;
const GENIUS_USER_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
const SHOT_DIR = "tmp/qa-screenshots/feature-guide";
const VIEWPORT = { width: 390, height: 844 };

/** 실유저 원장(state/yaj-48h/failure-ledger-20260905) 문장 그대로. */
const DEFAULT_CASES: ReadonlyArray<{ q: string; expect: ProductFeatureKey | null }> = [
  { q: "워치 연동 어떻게 해요?", expect: "스마트워치" },
  { q: "배경화면에 스코어 띄울 수 있나요", expect: "홈위젯" },
  { q: "잠금화면에 점수 띄울 수 있어?", expect: "잠금화면중계" },
  { q: "gps인증 어떻게 해요", expect: "직관인증" },
  { q: "최애선수 등록 어케해", expect: "최애선수" },
  { q: "TV 중계 어디서 봐?", expect: "영상중계시청" },
  // 음성: 기록 술어 — 기능 안내로 새면 안 된다(삼순 조건부 GO ①).
  { q: "최애팀 몇 위야?", expect: null },
];
/** 진단용 오버라이드: QA_CASES='[{"q":"…","expect":null}]' (기본은 위 원장 문장). */
const CASES: ReadonlyArray<{ q: string; expect: ProductFeatureKey | null }> = process.env.QA_CASES
  ? JSON.parse(process.env.QA_CASES)
  : DEFAULT_CASES;

const admin = createClient(SUPABASE_URL!, SERVICE_ROLE!, { auth: { autoRefreshToken: false, persistSession: false } });
const results: Array<{ name: string; pass: boolean }> = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function createTestSession() {
  const stamp = Date.now().toString(36);
  const email = `qa-feature-guide-${stamp}@keubo-test.local`;
  const password = `QaFg!${stamp}`;
  const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !created.user) throw new Error(`createUser: ${error?.message ?? "user missing"}`);
  const { error: profileError } = await admin.from("profiles").upsert({ id: created.user.id, nickname: `QA기능안내${stamp.slice(-4)}`, team_id: 1 });
  if (profileError) throw new Error(`profile upsert: ${profileError.message}`);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON!, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  const session = await res.json();
  if (!res.ok || !session.access_token) throw new Error(`test sign-in: ${res.status}`);
  return { session, user: created.user };
}

async function ctxWithSession(browser: playwright.Browser, session: any, user: any) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block" });
  const key = `sb-${REF}-auth-token`;
  const slimUser = { id: user.id, email: user.email, aud: user.aud, role: user.role, app_metadata: {}, user_metadata: {}, created_at: user.created_at };
  const value = JSON.stringify({
    access_token: session.access_token, refresh_token: session.refresh_token,
    expires_in: session.expires_in ?? 3600, expires_at: session.expires_at, token_type: "bearer", user: slimUser,
  });
  const u = new URL(BASE_URL);
  const expires = Number(session.expires_at);
  await ctx.addCookies([{
    name: key, value: `base64-${Buffer.from(value).toString("base64")}`, domain: u.hostname, path: "/",
    httpOnly: false, secure: u.protocol === "https:", sameSite: "Lax", ...(Number.isFinite(expires) ? { expires } : {}),
  }]);
  await ctx.addInitScript(([k, v]: string[]) => window.localStorage.setItem(k, v), [key, value]);
  return ctx;
}

async function deleteTestUser(userId: string) {
  const profileDel = await admin.from("profiles").delete().eq("id", userId);
  if (profileDel.error) throw new Error(`profile delete: ${profileDel.error.message}`);
  const authDel = await admin.auth.admin.deleteUser(userId);
  if (authDel.error) throw new Error(`auth delete: ${authDel.error.message}`);
  const { data: still } = await admin.auth.admin.getUserById(userId);
  if (still?.user) throw new Error(`postcondition: 테스트 계정이 아직 남아 있다 ${userId}`);
}

let browser: playwright.Browser | null = null;
let testUserId: string | null = null;
async function main() {
try {
  mkdirSync(SHOT_DIR, { recursive: true });
  console.log(`[feature-guide UI] base=${BASE_URL} bypass=${BYPASS ? "yes" : "no"}`);
  const { session, user } = await createTestSession();
  testUserId = user.id;
  console.log(`  test user ${user.id} (전용 계정, 종료 시 삭제)`);

  browser = await playwright.chromium.launch();
  const ctx = await ctxWithSession(browser, session, user);
  const page = await ctx.newPage();
  const bypassQ = BYPASS ? `?x-vercel-set-bypass-cookie=true&x-vercel-protection-bypass=${BYPASS}` : "";
  await page.goto(`${BASE_URL}/messages/new-${GENIUS_USER_ID}${bypassQ}`, { waitUntil: "networkidle", timeout: 60000 });
  const composer = page.getByPlaceholder("쪽지를 입력하세요...");
  await composer.waitFor({ state: "visible", timeout: 30000 });
  ok("로그인 상태로 야잘알봇 쪽지방 진입(입력창 노출)", true, page.url().replace(/\?.*$/, ""));

  for (const [i, c] of CASES.entries()) {
    const before = await page.locator("[data-genius-question-id]").count();
    await composer.fill(c.q);
    await page.getByRole("button", { name: "쪽지 보내기" }).click();
    let replyText: string | null = null;
    try {
      await page.waitForFunction((n) => document.querySelectorAll("[data-genius-question-id]").length > n, before, { timeout: 60000 });
      const bubble = page.locator("[data-genius-question-id]").last();
      replyText = ((await bubble.locator("p.whitespace-pre-wrap").first().textContent()) ?? "").trim();
    } catch {
      replyText = null;
    }
    await page.screenshot({ path: `${SHOT_DIR}/${String(i + 1).padStart(2, "0")}.png`, fullPage: false });
    if (c.expect === null) {
      const leaked = replyText !== null && CASES.some((x) => x.expect !== null && replyText === productFeatureGuideAnswer(x.expect));
      ok(`음성 「${c.q}」 → 기능 안내 문구 아님`, replyText !== null && !leaked, replyText ? replyText.slice(0, 60) : "답변 미도착");
    } else {
      const expected = productFeatureGuideAnswer(c.expect);
      ok(`「${c.q}」 → ${c.expect} 문구 완전 일치`, replyText === expected, replyText === expected ? `${expected.slice(0, 40)}…` : `받은 답: ${(replyText ?? "미도착").slice(0, 80)}`);
    }
  }

  // 서버 원장에도 기능 안내 라우팅이 남았는지(화면 ↔ 로그 일치).
  const { data: logs, error: logErr } = await admin
    .from("genius_question_logs").select("question, match_path, answer").eq("user_id", user.id).order("created_at", { ascending: true });
  if (logErr) console.log(`  (log 조회 실패: ${logErr.message})`);
  else {
    const guided = (logs ?? []).filter((l: any) => l.match_path === "product_feature_guide").length;
    ok(`genius_question_logs match_path=product_feature_guide ${guided}건 = 양성 ${CASES.filter((c) => c.expect).length}건`, guided === CASES.filter((c) => c.expect).length, JSON.stringify((logs ?? []).map((l: any) => [l.question, l.match_path])));
  }
} catch (e) {
  ok(`예외: ${(e as Error).message}`, false);
} finally {
  if (browser) await browser.close();
  if (testUserId) {
    try { await deleteTestUser(testUserId); ok("전용 계정 삭제 postcondition", true, testUserId); }
    catch (e) { ok(`전용 계정 삭제 실패: ${(e as Error).message}`, false); }
  }
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\nfeature-guide UI smoke: PASS=${results.length - failed} FAIL=${failed} (screenshots ${SHOT_DIR}/)`);
process.exit(failed ? 1 : 0);
}
void main();
