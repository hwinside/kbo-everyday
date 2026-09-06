#!/usr/bin/env -S npx tsx
/**
 * 야잘알봇 앱 기능 안내 — End-User Level QA (#1344, 삼순 HOLD ③ "전용 계정 UI 증거").
 *
 * 실제 배포본(프리뷰/프로덕션)의 쪽지방 UI 에서 전용 테스트 계정으로 질문을 보내고,
 * 봇이 화면에 렌더한 답변 원문이 `PRODUCT_FEATURE_REGISTRY` 문구와 **완전 일치**하는지 본다.
 *
 *  - 하린아빠 개인/공유 계정 사용 금지(AGENTS.md P0) → 실행마다 전용 계정 생성 → 종료 시 삭제(postcondition 확인)
 *  - 스텁 종단 게이트(`genius-product-feature-guide.ts`)와 달리 여기서는 서버·DB·LLM 경로를 우회하지 않는다
 *  - 음성 질문은 화면 ↔ 질문별 서버 로그가 일치하고 정상 야구 경로여야 한다(error/unsure 는 실패).
 *  - 웹 메뉴 이동만 자동화한다. 네이티브 잠금화면·OS 위젯·워치 동작은 삼식의 실기기 QA가 별도 필요하다.
 *  - 배포 SHA 결속은 실행자가 배포 메타데이터로 별도 확인한다. 로컬 HEAD나 URL만으로 동일 exact를 주장하지 않는다.
 *
 * 사용: QA_BASE_URL=https://<preview>.vercel.app npx tsx scripts/qa/genius-product-feature-guide-ui-smoke.ts
 *   프리뷰 보호는 .env.local 의 VERCEL_PROTECTION_BYPASS_TOKEN 으로 우회(값은 출력하지 않는다).
 */
import { createClient, type Session, type User } from "@supabase/supabase-js";
import playwright from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ANON, BASE, REF, SERVICE_ROLE, SUPABASE_URL } from "./_env.mjs";
import { PRODUCT_FEATURE_KEYS, productFeatureGuideAnswer, type ProductFeatureKey } from "../../src/lib/baseball-qa/pipeline";

const BASE_URL = process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] ?? BASE;
const BYPASS = process.env.VERCEL_PROTECTION_BYPASS_TOKEN;
const GENIUS_USER_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
const SHOT_DIR = `tmp/qa-screenshots/feature-guide/${Date.now()}`;
const VIEWPORT = { width: 390, height: 844 };
type QaCase = { q: string; expect: ProductFeatureKey | null };
const BASEBALL_PATHS = new Set(["llm", "rag", "team_rag", "dictionary", "kbo_structured"]);
const registryAnswers = new Set(PRODUCT_FEATURE_KEYS.map(productFeatureGuideAnswer));

/** 실유저 원장(state/yaj-48h/failure-ledger-20260905) 문장 그대로. */
const DEFAULT_CASES: ReadonlyArray<QaCase> = [
  { q: "워치 연동 어떻게 해요?", expect: "스마트워치" },
  { q: "배경화면에 스코어 띄울 수 있나요", expect: "홈위젯" },
  { q: "잠금화면에 점수 띄울 수 있어?", expect: "잠금화면중계" },
  { q: "gps인증 어떻게 해요", expect: "직관인증" },
  { q: "최애선수 등록 어케해", expect: "최애선수" },
  { q: "TV 중계 어디서 봐?", expect: "영상중계시청" },
  // 음성: 기록 술어 — 기능 안내로 새면 안 된다(삼순 조건부 GO ①).
  { q: "최애팀 몇 위야?", expect: null },
  { q: "희생플라이는 어느 때 치는거야", expect: null },
];
/** 진단용 오버라이드: QA_CASES='[{"q":"…","expect":null}]' (기본은 위 원장 문장). */
function readCases(): ReadonlyArray<QaCase> {
  const input: unknown = process.env.QA_CASES ? JSON.parse(process.env.QA_CASES) : DEFAULT_CASES;
  if (!Array.isArray(input) || input.length < 1 || input.length > 20
    || input.some((c) => !c || typeof c.q !== "string" || !c.q.trim()
      || (c.expect !== null && !PRODUCT_FEATURE_KEYS.includes(c.expect)))
    || new Set(input.map((c) => c.q)).size !== input.length) {
    throw new Error("QA_CASES: 고유 질문 1~20개, expect는 registry 키 또는 null이어야 합니다");
  }
  return input;
}

const admin = createClient(SUPABASE_URL!, SERVICE_ROLE!, { auth: { autoRefreshToken: false, persistSession: false } });
const results: Array<{ name: string; pass: boolean }> = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function createTestSession() {
  const stamp = Date.now().toString(36);
  const email = `qa-feature-guide-${stamp}@keubo-test.local`;
  const password = randomBytes(24).toString("base64url");
  const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !created.user) throw new Error(`createUser: ${error?.message ?? "user missing"}`);
  testUserId = created.user.id; // 프로필/로그인 실패 때도 finally에서 회수한다.
  const { error: profileError } = await admin.from("profiles").upsert({ id: created.user.id, nickname: `QA기능안내${stamp.slice(-4)}`, team_id: 1 });
  if (profileError) throw new Error(`profile upsert: ${profileError.message}`);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON!, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  const session = await res.json();
  if (!res.ok || !session.access_token) throw new Error(`test sign-in: ${res.status}`);
  return { session, user: created.user };
}

async function ctxWithSession(browser: playwright.Browser, session: Session, user: User) {
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
  await ctx.addInitScript(([origin, k, v]: string[]) => {
    if (window.location.origin === origin) window.localStorage.setItem(k, v);
  }, [u.origin, key, value]);
  return ctx;
}

async function deleteTestUser(userId: string) {
  const profileDel = await admin.from("profiles").delete().eq("id", userId);
  if (profileDel.error) throw new Error(`profile delete: ${profileDel.error.message}`);
  const authDel = await admin.auth.admin.deleteUser(userId);
  if (authDel.error) throw new Error(`auth delete: ${authDel.error.message}`);
  const { data: still, error: lookupError } = await admin.auth.admin.getUserById(userId);
  if (lookupError && lookupError.status !== 404 && lookupError.code !== "user_not_found") {
    throw new Error("postcondition: 계정 삭제 확인 조회 실패");
  }
  if (still?.user) throw new Error(`postcondition: 테스트 계정이 아직 남아 있다 ${userId}`);
}

/** 실제 클릭으로 메뉴 진입. 네이티브 브리지를 흉내내 잠금화면 지원을 PASS 처리하지 않는다. */
async function checkWebMenus(page: playwright.Page) {
  await page.goto(`${BASE_URL}/my`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "마이페이지", exact: true }).waitFor();
  await page.getByText("최애 선수", { exact: true }).click();
  await page.getByRole("heading", { name: "최애 선수를 골라주세요", exact: true }).waitFor();
  await page.getByText("최대 5명 · 선택한 선수 중심으로 피드가 구성됩니다", { exact: true }).waitFor();
  await page.screenshot({ path: `${SHOT_DIR}/menu-favorite-players.png` });
  ok("마이페이지 → 최애 선수 클릭 → 로그인 사용자 5명 선택 화면", true);

  await page.goto(`${BASE_URL}/my`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/settings");
  await page.getByRole("heading", { name: "설정", exact: true }).waitFor();
  ok("마이페이지 → 설정 버튼 클릭 → /settings 진입", true);
  ok("웹에서는 네이티브 전용 잠금화면 메뉴 미노출", await page.getByText("잠금화면", { exact: true }).count() === 0);
  await page.screenshot({ path: `${SHOT_DIR}/menu-settings-web.png` });
  console.log("  미검증: 네이티브 잠금화면 메뉴·권한·재표시, OS 위젯·워치, 경기 상세 동선은 별도 실환경 QA 필요");
}

let browser: playwright.Browser | null = null;
let testUserId: string | null = null;
async function main() {
try {
  const CASES = readCases();
  const baseUrl = new URL(BASE_URL);
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== "/") {
    throw new Error("QA_BASE_URL은 자격증명·쿼리 없는 origin이어야 합니다");
  }
  mkdirSync(SHOT_DIR, { recursive: true });
  console.log(`[feature-guide UI] base=${BASE_URL} bypass=${BYPASS ? "yes" : "no"}`);
  const { session, user } = await createTestSession();
  testUserId = user.id;
  console.log(`  test user ${user.id} (전용 계정, 종료 시 삭제)`);

  browser = await playwright.chromium.launch();
  const ctx = await ctxWithSession(browser, session, user);
  const page = await ctx.newPage();
  // 보호 우회 값은 URL/오류/스크린샷에 남기지 않으며 테스트 origin에만 전달한다.
  if (BYPASS) await ctx.route("**/*", async (route) => {
    const request = route.request();
    if (new URL(request.url()).origin !== baseUrl.origin) return route.continue();
    await route.continue({ headers: { ...request.headers(), "x-vercel-protection-bypass": BYPASS } });
  });
  await page.goto(`${BASE_URL}/messages/new-${GENIUS_USER_ID}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const composer = page.getByPlaceholder("쪽지를 입력하세요...");
  await composer.waitFor({ state: "visible", timeout: 30000 });
  ok("로그인 상태로 야잘알봇 쪽지방 진입(입력창 노출)", true, page.url().replace(/\?.*$/, ""));

  const replies = new Map<string, string | null>();
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
    replies.set(c.q, replyText);
    if (c.expect === null) {
      ok(`음성 「${c.q}」 → 빈 답/기능 안내 문구 아님(정상 경로는 로그로 추가 확인)`,
        !!replyText && !registryAnswers.has(replyText), replyText ? replyText.slice(0, 60) : "답변 미도착");
    } else {
      const expected = productFeatureGuideAnswer(c.expect);
      ok(`「${c.q}」 → ${c.expect} 문구 완전 일치`, replyText === expected, replyText === expected ? `${expected.slice(0, 40)}…` : `받은 답: ${(replyText ?? "미도착").slice(0, 80)}`);
    }
  }

  // 서버 원장에도 기능 안내 라우팅이 남았는지(화면 ↔ 로그 일치).
  // query-guard: bounded -- 전용 계정 1명 + 1~20 질문, 예상 건수+1(limit ≤21)로 중복/누락도 탐지.
  const { data: logs, error: logErr } = await admin
    .from("genius_question_logs").select("question, match_path, answer").eq("user_id", user.id)
    .order("created_at", { ascending: true }).limit(CASES.length + 1);
  ok("질문 로그 조회 성공", !logErr);
  if (!logErr) {
    ok("질문 로그 건수 일치(누락·중복 없음)", logs?.length === CASES.length);
    for (const c of CASES) {
      const rows = (logs ?? []).filter((l) => l.question === c.q);
      const row = rows[0];
      const normalPath = row && (c.expect === null
        ? BASEBALL_PATHS.has(row.match_path) : row.match_path === "product_feature_guide");
      ok(`「${c.q}」 화면↔로그 원문·정상 경로 일치`, rows.length === 1 && !!replies.get(c.q)
        && row.answer === replies.get(c.q) && !!normalPath, row?.match_path ?? "로그 없음");
    }
    if (CASES.some((c) => c.expect === null)) {
      ok("음성 회귀 중 실제 LLM/RAG 경로 응답 존재", (logs ?? []).some((l) =>
        CASES.some((c) => c.expect === null && c.q === l.question)
        && ["llm", "rag", "team_rag"].includes(l.match_path)));
    }
  }
  writeFileSync(`${SHOT_DIR}/answers.json`, JSON.stringify({ base: baseUrl.origin,
    cases: CASES.map((c) => ({ ...c, reply: replies.get(c.q) })), logs: logs ?? [],
    scope: "웹 UI/질문별 로그 보조 증거. 배포 SHA·답변 사실성·네이티브/외부 메뉴 QA 별도.",
  }, null, 2));
  await checkWebMenus(page);
} catch (e) {
  ok(`예외: ${(e as Error).message}`, false);
} finally {
  if (browser) {
    try { await browser.close(); } catch { ok("브라우저 종료 실패", false); }
  }
  if (testUserId) {
    try { await deleteTestUser(testUserId); ok("전용 계정 삭제 postcondition", true, testUserId); }
    catch (e) { ok(`전용 계정 삭제 실패: ${(e as Error).message}`, false); }
  }
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\nfeature-guide 웹 UI smoke: PASS=${results.length - failed} FAIL=${failed} (증거 ${SHOT_DIR}/; 전체 End-User QA 판정 아님)`);
process.exit(failed ? 1 : 0);
}
void main();
