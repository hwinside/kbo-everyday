#!/usr/bin/env node
/**
 * 직관 다이어리 End-User UI 스모크.
 * 일회용 로그인 유저를 만들고, migration HOLD 중인 attendance API만 브라우저에서 fixture로 대체한다.
 * 실제 AuthContext 로그인·/my 렌더·경기 상세 펼침·공개 프로필 비노출을 검증한 뒤 유저를 정리한다.
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
  await page.route("**/api/me/venue-attendance**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(diaryFixture),
  }));

  await page.goto(`${BASE_URL}/my`, { waitUntil: "networkidle" });
  await page.getByText("직관 다이어리", { exact: true }).waitFor();
  if (!(await page.getByText("2경기", { exact: true }).isVisible())) throw new Error("attendance count missing");
  if (!(await page.getByText("100.0%", { exact: true }).isVisible())) throw new Error("win rate missing");
  await page.locator("button").filter({ hasText: "LG vs 롯데" }).first().click();
  await page.getByText("내 최애선수 오늘 활약", { exact: true }).waitFor();
  if (!(await page.getByText("평균 이상", { exact: true }).isVisible())) throw new Error("comparison missing");
  if (!(await page.getByText("경기 타율 .500 · 경기 전 시즌 .270", { exact: true }).isVisible())) throw new Error("official metric comparison missing");
  if (!(await page.getByText("경기 전 평균 · 3.7타수 1.0안타 0.2홈런 0.8타점", { exact: true }).isVisible())) throw new Error("per-game average missing");
  await page.locator("button").filter({ hasText: "LG vs 두산" }).first().click();
  await page.getByText("기록 확인 중", { exact: true }).waitFor();
  await page.screenshot({ path: resolve(SHOT_DIR, "venue-diary-my.png"), fullPage: true });

  await page.goto(`${BASE_URL}/profile/${userId}`, { waitUntil: "networkidle" });
  if (await page.getByText("직관 다이어리", { exact: true }).count()) {
    throw new Error("public profile leaked venue diary");
  }
  await page.screenshot({ path: resolve(SHOT_DIR, "venue-diary-public-profile.png"), fullPage: true });
  await browser.close();
  console.log("venue diary UI smoke: PASS (login + /my summary/detail + public profile privacy)");
}

try {
  await main();
} finally {
  if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
}
