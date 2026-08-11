#!/usr/bin/env node
/**
 * 홈 마이팀 즉시 렌더 — **로그인 경로** E2E (merge 전 근거, 게이트 아님·워크플로 미결속)
 *
 * 삼순 리뷰 #1154 NO-GO ③ 반영: 비로그인 수치만으로는 부족하다. 변경의 핵심 타깃인
 * 로그인 profile 게이트 경로를 merge 전에 실계정으로 검증한다.
 *
 * 시나리오 (전용 일회용 테스트 계정 2개 — 개인/공유 계정 QA 금지 P0 준수, 종료 시 삭제):
 *  S1 동일계정 재진입: 계정 A 세션 쿠키 + A 귀속 localStorage(kbo-auth-uid=A) →
 *     홈 진입→MY TEAM 카드 시간 측정. 카드는 A 팀이어야 한다.
 *  S2 계정 전환(A→B): A 귀속 localStorage + **B 세션 쿠키** →
 *     ① A 팀 카드가 순간이라도 렌더되면 FAIL(오표시 0 — MutationObserver 로 전 구간 감시)
 *     ② 최종적으로 B 팀 카드가 렌더돼야 한다
 *     ③ 계정전환 정리가 실키(kbo-favorite-players)를 지웠는지 확인 (NO-GO ② 회귀 방지)
 *
 * 하네스: home-myteam-render-time.mjs 와 동일 — next 바이너리 직접 + detached 그룹 종료 +
 * served buildId 대조 + 포트 선점/해제 fail-close.
 *
 * 세션 쿠키: @supabase/ssr 실포맷(`base64-` + base64url(JSON), 3180자 청크)으로 직접 굽는다.
 * 사용: node scripts/qa/home-login-ab-e2e.mjs [--port 3993] [--latency 150] [--runs 3]
 * exit 0 = 전 시나리오 PASS, 1 = FAIL(fail-close)
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "../..");
const PORT = Number(getArg("--port") || 3993);
const LATENCY_MS = Number(getArg("--latency") || 150);
const RUNS = Number(getArg("--runs") || 3);
// 장애 주입: 실기기에서 관측된 "느린 인증/프로필 페치"를 재현한다(영상 실측: 환영
// 토스트 ~7초 = 그때야 인증 완료). 로컬은 auth/자사 API 가 수백 ms 라 개선이 안 보이므로
// /api/me 와 supabase auth 엔드포인트에 인위 지연을 걸어 구조적 차이를 증명한다.
const AUTH_DELAY_MS = Number(getArg("--auth-delay") || 0);
// 만료 토큰 재진입(S1E): 앱 재실행의 실제 조건 — access token 은 만료, refresh 로 복원.
// supabase-js 가 refresh 네트워크를 끝내야 세션이 서는 경로를 재현한다(auth-delay 와 조합).
const EXPIRED = process.argv.includes("--expired");
// 감시자 검출력 셀프테스트: pending 없이 로컬 A 만 두면(비로그인) A 카드가 렌더되므로
// 감시자가 정상이라면 반드시 wrongSeen=true 가 떠야 한다(= RED 증명용).
const S3_SELFTEST = process.argv.includes("--s3-detector-selftest");

function getArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function fail(msg) { console.error("E2E-FAIL " + msg); process.exitCode = 1; throw new Error(msg); }

// ── env ──────────────────────────────────────────────────────────────────────
function loadEnv() {
  const env = {};
  for (const line of readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return env;
}

// ── supabase admin ───────────────────────────────────────────────────────────
async function sb(env, pathname, init = {}, useService = true) {
  const key = useService ? env.SUPABASE_SERVICE_ROLE_KEY : env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const res = await fetch(env.NEXT_PUBLIC_SUPABASE_URL + pathname, {
    ...init,
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      "Content-Type": "application/json", ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json, text };
}

async function createUser(env, email, password) {
  const r = await sb(env, "/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (r.status >= 300 || !r.json?.id) fail(`테스트 유저 생성 실패(${r.status}): ${r.text.slice(0, 200)}`);
  return r.json.id;
}

async function upsertProfile(env, id, nickname, teamId) {
  const r = await sb(env, "/rest/v1/profiles?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ id, nickname, team_id: teamId, favorite_players: [] }]),
  });
  if (r.status >= 300) fail(`profiles upsert 실패(${r.status}): ${r.text.slice(0, 200)}`);
}

/**
 * 테스트 계정 삭제 — fail-close(삼순 리뷰 #1154 2차 ③): 삭제 결과를 검증(auth GET 404
 * + profiles 0행)하고 재시도한다. 잔존이면 false 를 돌려 테스트 전체를 FAIL 로 묶는다.
 */
async function deleteUser(env, id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await sb(env, `/rest/v1/profiles?id=eq.${id}`, { method: "DELETE" });
    await sb(env, `/auth/v1/admin/users/${id}`, { method: "DELETE" });
    const chk = await sb(env, `/auth/v1/admin/users/${id}`, { method: "GET" });
    const prof = await sb(env, `/rest/v1/profiles?id=eq.${id}&select=id`, { method: "GET" });
    const authGone = chk.status === 404 || !chk.json?.id;
    const profGone = Array.isArray(prof.json) && prof.json.length === 0;
    if (authGone && profGone) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`E2E-FAIL 테스트 계정 잔존 id=${id} — 삭제 검증 3회 실패`);
  return false;
}

async function signIn(env, email, password) {
  const r = await sb(env, "/auth/v1/token?grant_type=password", {
    method: "POST", body: JSON.stringify({ email, password }),
  }, false);
  if (r.status >= 300 || !r.json?.access_token) fail(`로그인 실패(${r.status}): ${r.text.slice(0, 200)}`);
  return r.json; // { access_token, refresh_token, expires_at, user, ... }
}

// ── @supabase/ssr 실포맷 쿠키 (base64- + base64url, 3180자 청크) ─────────────
function toBase64Url(s) {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function sessionCookies(env, session) {
  const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  const name = `sb-${ref}-auth-token`;
  const value = "base64-" + toBase64Url(JSON.stringify(session));
  const MAX = 3180;
  const cookies = [];
  if (value.length <= MAX) {
    cookies.push({ name, value });
  } else {
    for (let i = 0; i * MAX < value.length; i++) {
      cookies.push({ name: `${name}.${i}`, value: value.slice(i * MAX, (i + 1) * MAX) });
    }
  }
  return cookies.map((c) => ({ ...c, url: `http://localhost:${PORT}` }));
}

// ── server harness (home-myteam-render-time.mjs 와 동일 계약) ────────────────
async function portInUse() {
  return fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) })
    .then(() => true).catch(() => false);
}
function startServer() {
  const bin = path.join(ROOT, "node_modules/.bin/next");
  const child = spawn(bin, ["start", "-p", String(PORT)], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env }, detached: true,
  });
  child.__exited = false;
  child.on("exit", () => { child.__exited = true; });
  return child;
}
function signalTree(child, sig) {
  try { process.kill(-child.pid, sig); return; } catch { /* no group */ }
  try { child.kill(sig); } catch { /* dead */ }
}
async function stopServer(child) {
  signalTree(child, "SIGTERM");
  for (let i = 0; i < 20; i++) { if (!(await portInUse())) return; await new Promise(r => setTimeout(r, 500)); }
  signalTree(child, "SIGKILL");
  for (let i = 0; i < 10; i++) { if (!(await portInUse())) return; await new Promise(r => setTimeout(r, 500)); }
}

function todayYyyymmdd() {
  const kst = new Date(Date.now() + 9 * 3600_000);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

async function newPage(ctx) {
  const page = await ctx.newPage();
  if (AUTH_DELAY_MS > 0) {
    const delay = (route) => setTimeout(() => route.continue(), AUTH_DELAY_MS);
    await page.route("**/api/me", delay);
    await page.route("**/auth/v1/**", delay);
  }
  if (LATENCY_MS > 0) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, latency: LATENCY_MS,
      // 대역폭은 제한하지 않는다(-1): 4Mbps 캡은 JS 번들 다운로드(~3초)가 지배해 구조적
            // 지연(직렬 인증 대기) 차이를 가린다(2026-08-11 실측). RTT 만 재현한다.
            downloadThroughput: -1, uploadThroughput: -1,
    });
  }
  return page;
}

/** MY TEAM 배지에서 올라가며 특정 경기 앵커를 찾는 predicate (DOM 문자열) */
// ⚠️ 자기적발 2건(2026-08-11):
// - 문자열 함수식을 waitForFunction 에 넘기면 함수 객체 자체가 truthy 로 평가돼
//   즉시 통과(false-green)한다 → 반드시 **실함수**를 넘긴다.
// - 조상 탐색이 body/html 까지 올라가면 전체 DOM 을 뒤져 전체 경기 현황 카드까지
//   잡힌다 → body 미만으로 제한.
// 팀 id → shortName (src/lib/constants/teams.ts 와 동일 — 카드 헤더 텍스트 감시용)
const TEAM_SHORT = { 1: "LG", 2: "두산", 3: "KT", 4: "SSG", 5: "NC", 6: "KIA", 7: "롯데", 8: "삼성", 9: "한화", 10: "키움" };

// 카드 경계 판정: "MY TEAM" 배지에서 올라가며 **게임 앵커가 처음 나타나는 조상**을
// 카드 경계로 본다. TeamCard 는 게임 앵커가 정확히 1개, 전역 래퍼는 오늘 경기 수만큼
// 있으므로 "그 경계의 앵커 집합이 정확히 {href} 인가"로 판정하면 전역 오인이 없다.
const myteamAnchorPredicate = (href) => {
  const spans = Array.from(document.querySelectorAll("span"))
    .filter((s) => s.textContent && s.textContent.trim() === "MY TEAM");
  for (const s of spans) {
    let el = s.parentElement;
    for (let i = 0; i < 12 && el && el !== document.body && el !== document.documentElement; i++) {
      const anchors = [...el.querySelectorAll('a[href^="/games/"]')].map((a) => a.getAttribute("href"));
      if (anchors.length > 0) {
        const uniq = [...new Set(anchors)];
        return uniq.length === 1 && uniq[0] === href;
      }
      el = el.parentElement;
    }
  }
  return false;
};

async function main() {
  const env = loadEnv();
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.NEXT_PUBLIC_SUPABASE_URL) fail(".env.local 에 supabase 키 없음");
  if (!existsSync(path.join(ROOT, ".next"))) fail(".next 없음 — npx next build 후 실행");
  const buildId = readFileSync(path.join(ROOT, ".next/BUILD_ID"), "utf8").trim();
  if (await portInUse()) fail(`포트 ${PORT} 이미 사용 중`);

  const server = startServer();
  const ts = Date.now();
  const A = { email: `qa-speed-a-${ts}@keubo-qa.test`, pw: `Qa!${ts}a` };
  const B = { email: `qa-speed-b-${ts}@keubo-qa.test`, pw: `Qa!${ts}b` };
  let aId = null, bId = null, browser = null;
  try {
    let up = false;
    for (let i = 0; i < 75; i++) {
      if (server.__exited) fail("next start 조기 종료");
      up = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false);
      if (up) break;
      await new Promise(r => setTimeout(r, 800));
    }
    if (!up) fail("서버 기동 실패");
    const html = await (await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(10000) })).text();
    if (!html.includes(buildId)) fail(`served buildId(${buildId}) 불일치 — stale 서버`);

    const gamesRes = await fetch(`http://localhost:${PORT}/api/games?date=${todayYyyymmdd()}`).then(r => r.json());
    const games = gamesRes?.games ?? [];
    if (games.length < 2) fail("오늘 경기 2개 미만 — A/B 팀 분리 불가 (fail-close)");
    const gameA = games[0], gameB = games[1];
    const teamA = gameA.homeTeamId, teamB = gameB.homeTeamId;
    const hrefA = `/games/${gameA.gameId}`, hrefB = `/games/${gameB.gameId}`;

    aId = await createUser(env, A.email, A.pw);
    bId = await createUser(env, B.email, B.pw);
    await upsertProfile(env, aId, `큐에이속도A${ts % 10000}`, teamA);
    await upsertProfile(env, bId, `큐에이속도B${ts % 10000}`, teamB);
    const sessA = await signIn(env, A.email, A.pw);
    const sessB = await signIn(env, B.email, B.pw);

    const { chromium } = await import("playwright");
    browser = await chromium.launch();

    // ── S0: 쿠키 수용 sanity — A 쿠키만(로컬 없음). 세션이 서거면 profile A 가
    //    syncProfileToLocal 로 kbo-my-team 을 쓰고 MY TEAM 카드가 떠야 한다. ────
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await ctx.addCookies(sessionCookies(env, sessA));
      const page = await newPage(ctx);
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: "commit", timeout: 90000 });
      const okA = await page.waitForFunction(myteamAnchorPredicate, hrefA, { timeout: 45000 })
        .then(() => true).catch(() => false);
      const diag0 = await page.evaluate(() => ({
        uid: localStorage.getItem("kbo-auth-uid"),
        myteam: localStorage.getItem("kbo-my-team"),
        cookieNames: document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter((n) => n.startsWith("sb-")),
      }));
      console.log(`S0 쿠키 수용 sanity: card=${okA}`, JSON.stringify(diag0));
      if (!okA) fail("S0: 세션 쿠키로 로그인 상태가 서지 않음 — 쿠키 포맷/수용 경로 재점검 필요");
      await ctx.close();
    }

    // ── S1: 동일계정 재진입 (A 쿠키 + A 귀속 로컬) — 시간 측정 ────────────────
    const s1Times = [];
    for (let run = 0; run < RUNS; run++) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await ctx.addCookies(sessionCookies(env, sessA));
      const page = await newPage(ctx);
      await page.addInitScript(([teamId, uid]) => {
        localStorage.setItem("kbo-my-team", String(teamId));
        localStorage.setItem("kbo-onboarding-status", "completed");
        localStorage.setItem("kbo-auth-uid", uid);
      }, [teamA, aId]);
      const t0 = Date.now();
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: "commit", timeout: 90000 });
      const ok = await page.waitForFunction(myteamAnchorPredicate, hrefA, { timeout: 60000 })
        .then(() => true).catch(() => false);
      if (!ok) fail("S1: A 팀 MY TEAM 카드 미렌더");
      s1Times.push(Date.now() - t0);
      if (run === 0) {
        // 가드 파서 진단: 프로덕션 번들과 동일 로직을 페이지에서 재현해 cookie uid 판독 결과를 본다.
        const guardDiag = await page.evaluate(() => {
          try {
            const chunks = {};
            let found = false;
            for (const part of document.cookie.split(";")) {
              const eq = part.indexOf("=");
              if (eq < 0) continue;
              const name = part.slice(0, eq).trim();
              const m = name.match(/^(sb-.+-auth-token)(?:\.(\d+))?$/);
              if (!m) continue;
              found = true;
              (chunks[m[1]] ??= []).push({ idx: m[2] ? Number(m[2]) : 0, value: part.slice(eq + 1).trim() });
            }
            if (!found) return { r: null };
            for (const base of Object.keys(chunks)) {
              const joined = chunks[base].sort((a, b) => a.idx - b.idx).map((c) => c.value).join("");
              const decoded = decodeURIComponent(joined);
              const raw = decoded.startsWith("base64-")
                ? atob(decoded.slice(7).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil((decoded.length - 7) / 4) * 4, "="))
                : decoded;
              const parsed = JSON.parse(raw);
              if (parsed?.user?.id) return { r: parsed.user.id };
            }
            return { r: "unknown", why: "no-user" };
          } catch (e) { return { r: "unknown", why: String(e && e.message) }; }
        });
        console.log(`S1 guard diag: parsedUid=${JSON.stringify(guardDiag)} aId=${aId}`);
      }
      await ctx.close();
    }
    s1Times.sort((a, b) => a - b);
    console.log(`S1 동일계정 재진입(A): runs=${JSON.stringify(s1Times)}ms median=${s1Times[Math.floor(s1Times.length / 2)]}ms — A팀 카드 렌더 확인`);

    // ── S1E: 만료 토큰 재진입 (A 귀속 로컬 + 만료된 A 쿠키) — 앱 재실행 재현 ────
    if (EXPIRED) {
      const sessExpired = { ...sessA, expires_at: Math.floor(Date.now() / 1000) - 100, expires_in: -100 };
      const times = [];
      for (let run = 0; run < RUNS; run++) {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        await ctx.addCookies(sessionCookies(env, sessExpired));
        const page = await newPage(ctx);
        await page.addInitScript(([teamId, uid]) => {
          localStorage.setItem("kbo-my-team", String(teamId));
          localStorage.setItem("kbo-onboarding-status", "completed");
          localStorage.setItem("kbo-auth-uid", uid);
        }, [teamA, aId]);
        const t0 = Date.now();
        await page.goto(`http://localhost:${PORT}/`, { waitUntil: "commit", timeout: 90000 });
        const ok = await page.waitForFunction(myteamAnchorPredicate, hrefA, { timeout: 60000 })
          .then(() => true).catch(() => false);
        if (!ok) fail("S1E: 만료 토큰 재진입에서 A 팀 카드 미렌더");
        times.push(Date.now() - t0);
        await ctx.close();
      }
      times.sort((a, b) => a - b);
      console.log(`S1E 만료토큰 재진입(A): runs=${JSON.stringify(times)}ms median=${times[Math.floor(times.length / 2)]}ms`);
    }

    // ── S2: 계정 전환 (A 로컬 + B 쿠키) — 오표시 0 + 정리키 검증 ──────────────
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await ctx.addCookies(sessionCookies(env, sessB));
      const page = await newPage(ctx);
      await page.addInitScript(([teamId, uid, wrongName, rightName]) => {
        localStorage.setItem("kbo-my-team", String(teamId));
        localStorage.setItem("kbo-onboarding-status", "completed");
        localStorage.setItem("kbo-favorite-players", JSON.stringify([{ kboId: "99999", name: "테스트선수" }]));
        localStorage.setItem("kbo-auth-uid", uid);
        // 오표시 0 계약 — 앵커가 아니라 **팀 헤더 자체**를 첫 mutation 부터 감시한다
        // (삼순 2차 ②: TeamCard 는 API 완료 전에도 팀명·로고·MY TEAM 헤더를 먼저 그린다).
        // "MY TEAM" 배지에서 올라가 팀명이 처음 등장하는 레벨(=카드 헤더 스코프)에서
        // 이전 계정 팀명만 보이면 오표시로 기록한다.
        window.__WRONG_TEAM_SEEN = false;
        const check = () => {
          const spans = Array.from(document.querySelectorAll("span"))
            .filter((s) => s.textContent && s.textContent.trim() === "MY TEAM");
          for (const s of spans) {
            let el = s.parentElement;
            for (let i = 0; i < 12 && el && el !== document.body && el !== document.documentElement; i++) {
              const t = el.textContent || "";
              const hasWrong = t.includes(wrongName);
              const hasRight = t.includes(rightName);
              if (hasWrong || hasRight) {
                if (hasWrong && !hasRight) window.__WRONG_TEAM_SEEN = true;
                break;
              }
              el = el.parentElement;
            }
          }
        };
        // MutationObserver 는 document-start 타이밍/예외에 취약하다(2026-08-11 selftest 에서
        // 무검출 실측) — 오류를 캡처하고 50ms 폴링을 병행해 검출을 보장한다.
        window.__OBS_ERR = null;
        try {
          check();
          new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
        } catch (e) { window.__OBS_ERR = String(e && e.message); }
        setInterval(check, 50);
      }, [teamA, aId, TEAM_SHORT[teamA], TEAM_SHORT[teamB]]);
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: "commit", timeout: 90000 });
      const okB = await page.waitForFunction(myteamAnchorPredicate, hrefB, { timeout: 60000 })
        .then(() => true).catch(() => false);
      if (!okB) fail("S2: 전환 후 B 팀 MY TEAM 카드 미렌더");
      const diag = await page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll("span"))
          .filter((s) => s.textContent && s.textContent.trim() === "MY TEAM");
        const hrefs = new Set();
        for (const s of spans) {
          let el = s.parentElement;
          for (let i = 0; i < 10 && el && el !== document.body && el !== document.documentElement; i++) {
            el.querySelectorAll('a[href^="/games/"]').forEach((a) => hrefs.add(a.getAttribute("href")));
            el = el.parentElement;
          }
        }
        return {
          uid: localStorage.getItem("kbo-auth-uid"),
          myteam: localStorage.getItem("kbo-my-team"),
          fav: localStorage.getItem("kbo-favorite-players"),
          onboarding: localStorage.getItem("kbo-onboarding-status"),
          spanCount: spans.length,
          nearHrefs: [...hrefs],
        };
      });
      console.log(`S2 diag: aId=${aId} bId=${bId} hrefA=${hrefA} hrefB=${hrefB}`, JSON.stringify(diag));
      const wrongSeen = await page.evaluate(() => window.__WRONG_TEAM_SEEN);
      if (wrongSeen) fail("S2: 계정 전환 중 이전 계정(A) 팀 카드가 렌더됨 — 오표시 발생");
      const favLeft = await page.evaluate(() => localStorage.getItem("kbo-favorite-players"));
      const uidNow = await page.evaluate(() => localStorage.getItem("kbo-auth-uid"));
      // 정리 후 loadProfile 이 B 의 값(빈 배열)을 다시 쓸 수 있다 — 계약은
      // "이전 계정(A)의 데이터가 남지 않는다"이다. null 또는 A 테스트값 부재면 PASS.
      if (favLeft !== null && favLeft.includes("99999")) fail(`S2: 계정전환 후 이전 계정 최애선수 잔존 (${String(favLeft).slice(0, 60)})`);
      if (uidNow !== bId) fail(`S2: kbo-auth-uid 가 B 로 갱신 안 됨 (${uidNow})`);
      console.log("S2 계정 전환(A→B): 이전 팀 오표시 0 · B팀 카드 렌더 · kbo-favorite-players 정리 · kbo-auth-uid=B 확인");
      await ctx.close();
    }
    // ── S3: iOS Safari pending-session 경로 (무쿠키 + kbo-pending-session=B + 로컬 A)
    //    삼순 2차 ①: 쿠키 없음=비로그인 판정이 이 경로를 놓치면 pending B 복원 중
    //    로컬 A 를 선렌더한다. 가드가 pending 을 fail-close 해야 오표시 0. ────────
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await newPage(ctx);
      await page.addInitScript(([teamId, uid, pending, wrongName, rightName]) => {
        localStorage.setItem("kbo-my-team", String(teamId));
        localStorage.setItem("kbo-onboarding-status", "completed");
        localStorage.setItem("kbo-auth-uid", uid);
        if (pending) sessionStorage.setItem("kbo-pending-session", pending);
        window.__SEEN_LOG = [];
        window.__WRONG_TEAM_SEEN = false;
        const check = () => {
          const spans = Array.from(document.querySelectorAll("span"))
            .filter((s) => s.textContent && s.textContent.trim() === "MY TEAM");
          for (const s of spans) {
            let el = s.parentElement;
            for (let i = 0; i < 12 && el && el !== document.body && el !== document.documentElement; i++) {
              const t = el.textContent || "";
              const hasWrong = t.includes(wrongName);
              const hasRight = t.includes(rightName);
              if (hasWrong || hasRight) {
                window.__SEEN_LOG.push({ t: Date.now(), w: hasWrong, r: hasRight, depth: i });
                if (hasWrong && !hasRight) window.__WRONG_TEAM_SEEN = true;
                break;
              }
              el = el.parentElement;
            }
          }
        };
        // MutationObserver 는 document-start 타이밍/예외에 취약하다(2026-08-11 selftest 에서
        // 무검출 실측) — 오류를 캡처하고 50ms 폴링을 병행해 검출을 보장한다.
        window.__OBS_ERR = null;
        try {
          check();
          new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
        } catch (e) { window.__OBS_ERR = String(e && e.message); }
        setInterval(check, 50);
      }, [teamA, aId, S3_SELFTEST ? "" : JSON.stringify({ access_token: sessB.access_token, refresh_token: sessB.refresh_token }), TEAM_SHORT[teamA], TEAM_SHORT[teamB]]);
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: "commit", timeout: 90000 });
      if (S3_SELFTEST) {
        // 검출력 증명: 비로그인 + 로컬 A → A 카드가 렌더되고 감시자가 잡아야 한다.
        await page.waitForFunction(myteamAnchorPredicate, hrefA, { timeout: 60000 })
          .catch(() => fail("S3-selftest: A 카드 미렌더"));
        const seen = await page.evaluate(() => ({ wrong: window.__WRONG_TEAM_SEEN, log: window.__SEEN_LOG.slice(0, 5) }));
        console.log(`S3-selftest: wrongSeen=${seen.wrong} log=${JSON.stringify(seen.log)}`);
        if (!seen.wrong) fail("S3-selftest: 감시자가 A 팀 헤더를 못 잡음 — 검출력 없음(false-green)");
        await ctx.close();
        console.log(`buildId=${buildId} — S3 감시자 검출력 확인(RED 정상)`);
        return;
      }
      const okB3 = await page.waitForFunction(myteamAnchorPredicate, hrefB, { timeout: 60000 })
        .then(() => true).catch(() => false);
      if (!okB3) fail("S3: pending-session 복원 후 B 팀 카드 미렌더");
      const wrongSeen3 = await page.evaluate(() => window.__WRONG_TEAM_SEEN);
      if (wrongSeen3) fail("S3: pending-session 복원 중 이전 계정(A) 팀 헤더가 렌더됨 — 오표시 발생");
      const uid3 = await page.evaluate(() => localStorage.getItem("kbo-auth-uid"));
      if (uid3 !== bId) fail(`S3: kbo-auth-uid 가 B 로 갱신 안 됨 (${uid3})`);
      console.log("S3 pending-session(무쿠키) 경로: 오표시 0 · B팀 카드 렌더 · uid=B 확인");
      await ctx.close();
    }

    console.log(`buildId=${buildId} latency=${LATENCY_MS}ms authDelay=${AUTH_DELAY_MS}ms — 전 시나리오 PASS`);
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    // cleanup 잔존 = 테스트 실패 (fail-close)
    const aGone = aId ? await deleteUser(env, aId) : true;
    const bGone = bId ? await deleteUser(env, bId) : true;
    if (!aGone || !bGone) process.exitCode = 1;
    await stopServer(server);
  }
}

main().catch((e) => { if (process.exitCode !== 1) { console.error("E2E-FAIL " + (e?.message || e)); process.exitCode = 1; } });
