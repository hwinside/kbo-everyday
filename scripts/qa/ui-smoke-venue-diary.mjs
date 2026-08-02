#!/usr/bin/env node
/**
 * 직관 다이어리 일반 공개 End-User UI 스모크 (2026-08-02 하린아빠 지시로 계약 반전).
 *
 * 이전 계약: 관리자 게이트(`AdminOnly`) — 일반 유저에게 `/my` 다이어리 카드·API 요청이
 * 모두 **차단**돼야 PASS 였다.
 * 현재 계약: 일반 공개 — 일반 로그인 유저에게 카드가 **렌더되고** 소유자 인증 API 를
 * 실제로 호출해 본인 기록을 표시해야 한다. 동시에 **공개 프로필에는 여전히 비노출**이어야
 * 한다(공개 범위가 넓어진 게 아니라 본인 화면 표시 게이트만 열린 것이기 때문).
 *
 * 즉 이 스모크는 "게이트가 열렸는가"와 "열려서는 안 되는 곳이 같이 열리지 않았는가"를
 * 함께 본다. 일회용 계정으로 검증하고 정리한다.
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ANON, REF, SERVICE_ROLE, SUPABASE_URL } from "./_env.mjs";

const BASE_URL = process.argv.find((arg) => arg.startsWith("--base-url="))?.split("=")[1]
  ?? "http://127.0.0.1:3100";
const SHOT_DIR = resolve(process.cwd(), "tmp/qa-screenshots");
mkdirSync(SHOT_DIR, { recursive: true });

const stamp = Date.now().toString(36);
const email = `qa-venue-${stamp}@keubo.fan`;
const password = `QaVenue!${stamp}`;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});
let userId = null;

async function signIn() {
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
  await context.addCookies([{
    name: key,
    value: `base64-${Buffer.from(value).toString("base64")}`,
    domain: new URL(BASE_URL).hostname,
    path: "/",
    httpOnly: false,
    secure: BASE_URL.startsWith("https://"),
    sameSite: "Lax",
    expires: session.expires_at,
  }]);
  await context.addInitScript(([storageKey, storageValue]) => {
    localStorage.setItem(storageKey, storageValue);
  }, [key, value]);
}

const diaryFixture = {
  season: 2026,
  summary: { attendanceCount: 2, wins: 1, losses: 0, draws: 0, finalCount: 1, winRate: 1 },
  games: [
    {
      id: 1,
      gameId: "20260721LGLT0",
      date: "2026-07-21",
      stadium: "잠실",
      favoriteTeamId: 1,
      recordedAt: "2026-07-21T09:30:00Z",
      status: "final",
      result: "W",
      awayTeam: { id: 1, name: "LG 트윈스", score: 5 },
      homeTeam: { id: 7, name: "롯데 자이언츠", score: 3 },
      favoritePlayers: [{
        playerId: "50108",
        name: "김현수",
        state: "rated",
        lines: [{
          type: "batter",
          state: "rated",
          evaluation: "above",
          priorAppearances: 3,
          metricLabel: "타율",
          todayMetric: 0.5,
          averageMetric: 0.27,
          today: { ab: 4, h: 2, hr: 1, rbi: 3 },
          average: { ab: 3.7, h: 1, hr: 0.2, rbi: 0.8 },
        }],
      }],
    },
    {
      id: 2,
      gameId: "20260722LGOB0",
      date: "2026-07-22",
      stadium: "잠실",
      favoriteTeamId: 1,
      recordedAt: "2026-07-22T09:30:00Z",
      status: "live",
      result: null,
      awayTeam: { id: 1, name: "LG 트윈스", score: 2 },
      homeTeam: { id: 2, name: "두산 베어스", score: 1 },
      favoritePlayers: [{ playerId: "50108", name: "김현수", state: "pending", lines: [] }],
    },
  ],
};

let pass = 0;
const fails = [];
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ""}`); }
};

async function main() {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw created.error ?? new Error("user create failed");
  userId = created.data.user.id;
  const profile = await admin.from("profiles").insert({
    id: userId,
    nickname: `직관QA${stamp.slice(-4)}`,
    team_id: 1,
    favorite_players: [{ playerId: "50108", name: "김현수", teamId: 1, position: "외야수", number: 22 }],
  });
  if (profile.error) throw profile.error;

  const session = await signIn();
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await injectSession(context, session);
  const page = await context.newPage();
  let attendanceRequests = 0;
  await page.route("**/api/me/venue-attendance**", (route) => {
    attendanceRequests++;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(diaryFixture),
    });
  });

  // ── ① 일반 로그인 유저 `/my` — 카드가 보이고 본인 데이터를 실제로 불러온다 ──
  await page.goto(`${BASE_URL}/my`, { waitUntil: "networkidle" });
  const card = page.getByText("직관 다이어리", { exact: true });
  check("일반 유저 /my 에 직관 다이어리 카드 노출", (await card.count()) > 0);
  check(
    "소유자 인증 API 를 실제로 호출",
    attendanceRequests > 0,
    `attendanceRequests=${attendanceRequests}`,
  );
  // 게이트만 연 것이지 데이터 경로가 바뀐 게 아니므로, 응답이 화면까지 도달하는지 본다.
  const body = await page.locator("body").innerText();
  check("응답 요약이 화면에 반영(인증 직관 카드)", body.includes("인증 직관"), body.slice(0, 200));
  check("경기별 기록 섹션 노출", body.includes("경기별 기록"), body.slice(0, 200));
  await page.screenshot({ path: resolve(SHOT_DIR, "venue-diary-my.png"), fullPage: true });

  // ── ② 공개 프로필 — 열려선 안 되는 곳. 표시 게이트만 열었다는 계약의 반대편 ──
  await page.goto(`${BASE_URL}/profile/${userId}`, { waitUntil: "networkidle" });
  check(
    "공개 프로필에는 여전히 직관 다이어리 비노출",
    (await page.getByText("직관 다이어리", { exact: true }).count()) === 0,
  );
  await page.screenshot({ path: resolve(SHOT_DIR, "venue-diary-public-profile.png"), fullPage: true });

  // ── ③ 비로그인 — 카드 자체가 mount 되지 않아야 한다(카드 내부 `if (!user) return null`) ──
  const anon = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const anonPage = await anon.newPage();
  let anonAttendance = 0;
  await anonPage.route("**/api/me/venue-attendance**", (route) => {
    anonAttendance++;
    return route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"인증이 필요합니다"}' });
  });
  await anonPage.goto(`${BASE_URL}/my`, { waitUntil: "networkidle" });
  check(
    "비로그인 유저에게는 카드 비노출",
    (await anonPage.getByText("직관 다이어리", { exact: true }).count()) === 0,
  );
  check("비로그인 유저는 attendance API 미호출", anonAttendance === 0, `anonAttendance=${anonAttendance}`);
  await anon.close();

  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fails.length} fail`);
  if (fails.length) throw new Error(`venue diary UI smoke FAILED: ${fails.join(" / ")}`);
  console.log("venue diary UI smoke: PASS (일반 공개 노출 + 공개 프로필/비로그인 비노출)");
}

try {
  await main();
} finally {
  if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
}
