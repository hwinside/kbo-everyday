#!/usr/bin/env node
/**
 * 직관 다이어리 일반 공개 End-User UI 스모크 (2026-08-02 하린아빠 지시로 계약 반전).
 *
 * 이전 계약: 관리자 게이트(`AdminOnly`) — 일반 유저에게 카드·API 가 **차단**돼야 PASS.
 * 현재 계약: 일반 공개 — 일반 로그인 유저에게 카드가 **렌더되고 실제 값이 화면에 찍혀야**
 * 하며, 동시에 **공개 프로필·익명·타인**에게는 여전히 안 보여야 한다.
 *
 * ⚠️ 이 스모크의 1차 판본은 false-green 이었다(삼순 P1 2026-08-02).
 * `diaryFixture` 에 필수 `diaryGameCount` 가 없고 미디어 목록 API 를 고정하지 않아
 * 화면이 실제로는 `NaN경기` + `아직 기록이 없어요` 였는데, assertion 이 섹션 제목
 * 문자열만 봐서 통과했다. 그래서 이 판본은
 *   - attendance + media 두 응답을 **계약 완형**으로 고정하고
 *   - 숫자·경기행·상대/스코어를 **exact 문자열**로 assert 하며
 *   - `NaN`/`undefined` 노출과 빈 상태 오출력을 명시적으로 FAIL 처리한다.
 *
 * 화면 값의 출처(구현 계약):
 *   인증 직관 = summary.attendanceCount (GPS 인증만)
 *   승률·승패 = overallSummary (기본 범위 `all` = 직접 추가 포함)
 *   다이어리 N경기 = diaryGameCount
 *   경기 카드 = **미디어 목록(games)** 기준, 성적은 attendance 의 같은 gameId 에서 병합
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
const password = `QaVenue!${stamp}`;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** 생성한 계정 — finally 에서 fail-close 정리한다. */
const created = [];
let pass = 0;
const fails = [];
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ""}`); }
};

async function signIn(email) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status}`);
  return response.json();
}

async function makeUser(tag) {
  const email = `qa-venue-${tag}-${stamp}@keubo.fan`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("user create failed");
  created.push({ id: data.user.id, email });
  const profile = await admin.from("profiles").insert({
    id: data.user.id,
    nickname: `직관${tag}${stamp.slice(-3)}`.slice(0, 12),
    team_id: 1,
    favorite_players: [{ playerId: "50108", name: "김현수", teamId: 1, position: "외야수", number: 22 }],
  });
  if (profile.error) throw profile.error;
  return { id: data.user.id, email, session: await signIn(email) };
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

// ── 계약 완형 fixture ────────────────────────────────────────────────────────
// 2경기 · 2승 0패 0무 · 승률 100.0% · 다이어리 2경기.
const GAME_A = "20260721LGLT0";
const GAME_B = "20260722LGOB0";

const attendanceFixture = {
  season: 2026,
  summary: { attendanceCount: 2, wins: 2, losses: 0, draws: 0, finalCount: 2, winRate: 1 },
  overallSummary: { attendanceCount: 2, wins: 2, losses: 0, draws: 0, finalCount: 2, winRate: 1 },
  diaryGameCount: 2,
  games: [
    {
      id: 1,
      gameId: GAME_A,
      date: "2026-07-21",
      stadium: "잠실",
      favoriteTeamId: 1,
      recordedAt: "2026-07-21T09:30:00Z",
      source: "story_geofence",
      venueVerified: true,
      status: "final",
      result: "W",
      awayTeam: { id: 1, name: "LG 트윈스", score: 5 },
      homeTeam: { id: 7, name: "롯데 자이언츠", score: 3 },
      favoritePlayers: [],
    },
    {
      id: 2,
      gameId: GAME_B,
      date: "2026-07-22",
      stadium: "잠실",
      favoriteTeamId: 1,
      recordedAt: "2026-07-22T09:30:00Z",
      source: "story_geofence",
      venueVerified: true,
      status: "final",
      result: "W",
      awayTeam: { id: 1, name: "LG 트윈스", score: 4 },
      homeTeam: { id: 2, name: "두산 베어스", score: 2 },
      favoritePlayers: [],
    },
  ],
};

// 경기 카드는 **미디어 목록** 기준으로 렌더된다 — 이걸 안 채우면 빈 상태가 나온다.
const mediaFixture = {
  season: 2026,
  games: [
    {
      gameId: GAME_A,
      gameDate: "2026-07-21",
      stadiumName: "잠실",
      counts: { image: 1, video: 0, total: 1 },
      thumbnails: [{
        id: 11,
        mediaType: "image",
        thumbUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        venueVerified: true,
      }],
    },
    {
      gameId: GAME_B,
      gameDate: "2026-07-22",
      stadiumName: "잠실",
      counts: { image: 1, video: 0, total: 1 },
      thumbnails: [{
        id: 12,
        mediaType: "image",
        thumbUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        venueVerified: true,
      }],
    },
  ],
  nextCursor: null,
  hasMore: false,
};

const emptyAttendance = {
  season: 2026,
  summary: { attendanceCount: 0, wins: 0, losses: 0, draws: 0, finalCount: 0, winRate: null },
  overallSummary: { attendanceCount: 0, wins: 0, losses: 0, draws: 0, finalCount: 0, winRate: null },
  diaryGameCount: 0,
  games: [],
};
const emptyMedia = { season: 2026, games: [], nextCursor: null, hasMore: false };

const json = (body) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** attendance/media 응답을 고정하고 호출 횟수를 센다. */
async function stub(target, { attendance, media }) {
  const counts = { attendance: 0, media: 0 };
  await target.route("**/api/me/venue-attendance**", (route) => {
    counts.attendance++;
    return attendance ? route.fulfill(json(attendance)) : route.fulfill({
      status: 401, contentType: "application/json", body: '{"error":"인증이 필요합니다"}',
    });
  });
  await target.route("**/api/me/venue-diary/media**", (route) => {
    counts.media++;
    return media ? route.fulfill(json(media)) : route.fulfill({
      status: 401, contentType: "application/json", body: '{"error":"인증이 필요합니다"}',
    });
  });
  return counts;
}

async function main() {
  const owner = await makeUser("owner");
  const other = await makeUser("other");

  const browser = await playwright.chromium.launch({ headless: true });

  // ── ① owner `/my` — 카드가 열리고 **실제 값**이 화면에 찍힌다 ──────────────
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await injectSession(context, owner.session);
    const page = await context.newPage();
    const counts = await stub(page, { attendance: attendanceFixture, media: mediaFixture });

    await page.goto(`${BASE_URL}/my`, { waitUntil: "networkidle" });
    check("owner /my 에 직관 다이어리 카드 노출", (await page.getByText("직관 다이어리", { exact: true }).count()) > 0);
    check("attendance API 실제 호출", counts.attendance > 0, `attendance=${counts.attendance}`);
    check("diary media API 실제 호출", counts.media > 0, `media=${counts.media}`);

    // 요약 3열이 fixture 값 그대로 찍혀야 한다(제목만 보고 통과하던 false-green 차단).
    const body = await page.locator("body").innerText();
    check("인증 직관 2 노출", /\b2\b[\s\S]{0,40}인증 직관/.test(body), body.slice(0, 400));
    check("승률 100.0% 노출(overallSummary 기준)", body.includes("100.0%"), body.slice(0, 400));
    check("다이어리 2경기 노출(diaryGameCount)", body.includes("2경기"), body.slice(0, 400));
    check("승패 2승 0패 0무 노출", body.includes("2승") && body.includes("0패") && body.includes("0무"), body.slice(0, 400));

    // 결측 계약 위반이 화면에 새는 것을 직접 차단한다.
    check("NaN 미노출", !body.includes("NaN"), body.slice(0, 400));
    check("undefined 미노출", !body.includes("undefined"), body.slice(0, 400));

    // 경기행이 실제로 렌더돼야 한다 — 상대·스코어까지 exact.
    check("경기별 기록 섹션 노출", body.includes("경기별 기록"), body.slice(0, 400));
    check("빈 상태 문구 미노출", !body.includes("아직 기록이 없어요"), body.slice(0, 400));
    check("경기행 A 상대·스코어 노출(LG 5 : 3 롯데)", body.includes("LG 5 : 3 롯데"), body.slice(0, 600));
    check("경기행 B 상대·스코어 노출(LG 4 : 2 두산)", body.includes("LG 4 : 2 두산"), body.slice(0, 600));
    const winBadges = (body.match(/\n승\n|(?<=\s)승(?=\s)/g) ?? []).length;
    check("경기행 2건 렌더", winBadges >= 2 || (body.match(/잠실/g) ?? []).length >= 2, `winBadges=${winBadges}`);

    await page.screenshot({ path: resolve(SHOT_DIR, "venue-diary-my.png"), fullPage: true });

    // ── ② 공개 프로필 — 열려선 안 되는 쪽 ──
    await page.goto(`${BASE_URL}/profile/${owner.id}`, { waitUntil: "networkidle" });
    check(
      "본인 공개 프로필에도 직관 다이어리 비노출",
      (await page.getByText("직관 다이어리", { exact: true }).count()) === 0,
    );
    await page.screenshot({ path: resolve(SHOT_DIR, "venue-diary-public-profile.png"), fullPage: true });
    await context.close();
  }

  // ── ③ 기록 0건 유저 — 빈 상태·CTA 가 정확히 나온다 ────────────────────────
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await injectSession(context, other.session);
    const page = await context.newPage();
    await stub(page, { attendance: emptyAttendance, media: emptyMedia });

    await page.goto(`${BASE_URL}/my`, { waitUntil: "networkidle" });
    const body = await page.locator("body").innerText();
    check("기록 0건 유저도 카드 자체는 노출", (await page.getByText("직관 다이어리", { exact: true }).count()) > 0);
    check("0경기 표시", body.includes("0경기"), body.slice(0, 400));
    check("빈 상태 문구 노출", body.includes("아직 기록이 없어요"), body.slice(0, 400));
    check("CTA 지난 경기 추가하기 노출", body.includes("지난 경기 추가하기"), body.slice(0, 400));
    check("기록 0건 화면에 NaN 미노출", !body.includes("NaN"), body.slice(0, 400));
    check("owner 경기가 새지 않음", !body.includes("LG 5 : 3 롯데"), body.slice(0, 400));
    await context.close();
  }

  // ── ④ 타인 계정 — owner 공개 프로필에서 owner 기록이 보이지 않는다 ────────
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await injectSession(context, other.session);
    const page = await context.newPage();
    await stub(page, { attendance: emptyAttendance, media: emptyMedia });
    await page.goto(`${BASE_URL}/profile/${owner.id}`, { waitUntil: "networkidle" });
    const body = await page.locator("body").innerText();
    check(
      "타인 로그인 계정이 owner 공개 프로필에서 다이어리 비노출",
      (await page.getByText("직관 다이어리", { exact: true }).count()) === 0,
    );
    check("타인 화면에 owner 경기 비노출", !body.includes("LG 5 : 3 롯데"), body.slice(0, 400));
    await context.close();
  }

  // ── ⑤ 타인 세션의 서버 인가 — owner 기록이 API 로도 새지 않는다 ───────────
  {
    const res = await fetch(`${BASE_URL}/api/me/venue-attendance?season=2026`, {
      headers: { Authorization: `Bearer ${other.session.access_token}` },
    });
    const data = await res.json().catch(() => null);
    const ids = (data?.games ?? []).map((g) => g.gameId);
    check("타인 세션 attendance 200", res.status === 200, String(res.status));
    check(
      "타인 세션 응답에 owner 경기 없음(owner-only 서버 인가)",
      !ids.includes(GAME_A) && !ids.includes(GAME_B),
      JSON.stringify(ids).slice(0, 200),
    );
  }

  // ── ⑥ 익명 — 카드 자체가 mount 되지 않는다 ────────────────────────────────
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const counts = await stub(page, { attendance: null, media: null });
    await page.goto(`${BASE_URL}/my`, { waitUntil: "networkidle" });
    check("익명 유저에게 카드 비노출", (await page.getByText("직관 다이어리", { exact: true }).count()) === 0);
    check("익명 유저는 attendance API 미호출", counts.attendance === 0, `attendance=${counts.attendance}`);
    check("익명 유저는 media API 미호출", counts.media === 0, `media=${counts.media}`);
    await context.close();
  }

  await browser.close();
}

/**
 * 계정 정리 — **fail-close**.
 * 이전 판본은 `deleteUser(...).catch(() => {})` 라 삭제 실패도 조용히 exit 0 였다.
 * profile/auth 를 독립 시도하고 각 error 를 검사한 뒤, postcondition(0행/not-found)까지 확인한다.
 */
async function cleanup() {
  let cleanupFailed = false;
  for (const user of created) {
    const profileDel = await admin.from("profiles").delete().eq("id", user.id);
    if (profileDel.error) {
      console.error(`  ! profile 삭제 실패 ${user.email}: ${profileDel.error.message}`);
      cleanupFailed = true;
    }
    const authDel = await admin.auth.admin.deleteUser(user.id);
    if (authDel.error) {
      console.error(`  ! auth 삭제 실패 ${user.email}: ${authDel.error.message}`);
      cleanupFailed = true;
    }
    const { count, error: countErr } = await admin
      .from("profiles").select("id", { count: "exact", head: true }).eq("id", user.id);
    if (countErr) {
      console.error(`  ! profile postcondition 조회 실패 ${user.email}: ${countErr.message}`);
      cleanupFailed = true;
    } else if ((count ?? 0) !== 0) {
      console.error(`  ! profile 잔존 ${user.email}: count=${count}`);
      cleanupFailed = true;
    }
    const { data: still, error: getErr } = await admin.auth.admin.getUserById(user.id);
    if (still?.user) {
      console.error(`  ! auth 계정 잔존 ${user.email}`);
      cleanupFailed = true;
    } else if (getErr && !/not.?found|User not found/i.test(getErr.message)) {
      console.error(`  ! auth postcondition 조회 실패 ${user.email}: ${getErr.message}`);
      cleanupFailed = true;
    }
  }
  return cleanupFailed;
}

let runError = null;
try {
  await main();
} catch (error) {
  runError = error;
}
const cleanupFailed = await cleanup();
console.log(`\n결과: ${pass} pass / ${fails.length} fail`);
if (runError) {
  console.error(runError);
  process.exit(1);
}
if (fails.length) {
  console.error(`venue diary UI smoke FAILED: ${fails.join(" / ")}`);
  process.exit(1);
}
if (cleanupFailed) {
  console.error("venue diary UI smoke FAILED: 테스트 계정 정리 실패(잔존 계정 확인 필요)");
  process.exit(1);
}
console.log("venue diary UI smoke: PASS (일반 공개 노출 + 실값 렌더 + 익명/타인/공개프로필 비노출)");
