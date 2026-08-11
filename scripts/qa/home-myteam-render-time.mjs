#!/usr/bin/env node
/**
 * 홈 진입 → MY TEAM 경기 카드 렌더 시간 측정 (개선 전/후 근거용, 게이트 아님·워크플로 미결속)
 *
 * 배경(2026-08-11, #infra "서비스 속도"): 실기기 16초 중 최대 덩어리가 "홈이 다 채워질
 * 때까지"였고, 코드상 원인은 useHomeInit 온보딩 초기화 effect 의 `if (loading) return`
 * — 인증 확인(세션 복원→profile 페치)이 끝나야 localStorage 마이팀을 그렸다.
 *
 * 하네스 계약(삼순 리뷰 #1154 NO-GO ④ 반영 — rsc-prefetch-budget-gate 와 동일 축):
 * - `npx next start` 는 npx 가 중간 프로세스로 남아 SIGTERM 이 next-server 에 안 닿는다
 *   (CI run 31004480842 실측) → node_modules/.bin/next 를 **직접**, `detached` 로 띄우고
 *   종료는 프로세스 그룹(-pid) 전체에 보낸 뒤 **포트 해제까지 대기**한다.
 * - 서버 기동 후 **served buildId == .next/BUILD_ID** 를 대조해 stale 서버 측정을 fail-close.
 * - 포트 선점 시 fail-close(무엇을 측정하는지 보장 불가).
 *
 * 측정 계약:
 * - production build(`npx next build`) 산출물을 실브라우저(Chromium 390px)로 잰다.
 * - 비로그인 + localStorage(`kbo-my-team`, `kbo-onboarding-status=completed`) 주입.
 *   오늘 실경기에서 마이팀을 고른다(경기 없는 날 fail-close).
 * - `--latency <ms>` 로 CDP 네트워크 에뮬레이션(모바일 RTT 재현).
 * - 1회 = navigation 시작 → "MY TEAM" 배지에서 올라가 찾은 /games/* 앵커가 DOM 에
 *   나타날 때까지. N회 중앙값. 카드 미렌더는 fail-close.
 * - ⚠️ 비로그인 경로의 측정이다. 로그인 경로(동일계정 재진입·계정 전환 오표시 0)는
 *   scripts/qa/home-login-ab-e2e.mjs 가 전용 테스트 계정으로 검증한다.
 *
 * 사용: node scripts/qa/home-myteam-render-time.mjs [--port 3990] [--runs 5] [--latency 150]
 * exit 0 = 측정 성공, 1 = 측정 실패(fail-close)
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "../..");
const PORT = Number(getArg("--port") || 3990);
const RUNS = Number(getArg("--runs") || 5);
const LATENCY_MS = Number(getArg("--latency") || 0);

function getArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function fail(msg) {
  console.error("MEASURE-FAIL " + msg);
  process.exit(1);
}

function todayYyyymmdd() {
  const kst = new Date(Date.now() + 9 * 3600_000);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

async function portInUse() {
  return fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) })
    .then(() => true).catch(() => false);
}

/** next 바이너리 직접 + detached — 게이트(rsc-prefetch-budget-gate.mjs)와 동일 패턴. */
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
  try { process.kill(-child.pid, sig); return; } catch { /* 그룹 없으면 단일 */ }
  try { child.kill(sig); } catch { /* 이미 죽음 */ }
}

async function stopServer(child) {
  signalTree(child, "SIGTERM");
  for (let i = 0; i < 20; i++) {
    if (!(await portInUse())) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  signalTree(child, "SIGKILL");
  for (let i = 0; i < 10; i++) {
    if (!(await portInUse())) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  if (!existsSync(path.join(ROOT, ".next"))) fail(".next 없음 — npx next build 후 실행");
  const buildId = readFileSync(path.join(ROOT, ".next/BUILD_ID"), "utf8").trim();

  if (await portInUse()) fail(`포트 ${PORT} 이미 사용 중 — 무엇을 측정하는지 보장 불가`);

  const server = startServer();
  try {
    let up = false;
    for (let i = 0; i < 75; i++) {
      if (server.__exited) fail("next start 조기 종료");
      up = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(2000) })
        .then(r => r.ok).catch(() => false);
      if (up) break;
      await new Promise(r => setTimeout(r, 800));
    }
    if (!up) fail("서버 기동 실패");

    // served buildId 대조 — stale 서버 측정 fail-close (NO-GO ④)
    const html = await (await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(10000) })).text();
    if (!html.includes(buildId)) fail(`서빙 중인 앱에 로컬 buildId(${buildId}) 없음 — stale 서버 의심`);

    const gamesRes = await fetch(`http://localhost:${PORT}/api/games?date=${todayYyyymmdd()}`)
      .then(r => r.json()).catch(() => null);
    const game = gamesRes?.games?.[0];
    if (!game) fail("오늘 경기 없음 — 경기 있는 날에만 유효 (fail-close)");
    const myTeamId = game.homeTeamId;
    const gameHref = `/games/${game.gameId}`;

    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const times = [];
    try {
      for (let run = 0; run < RUNS; run++) {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const page = await ctx.newPage();
        await page.addInitScript(([teamId]) => {
          localStorage.setItem("kbo-my-team", String(teamId));
          localStorage.setItem("kbo-onboarding-status", "completed");
        }, [myTeamId]);
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

        const t0 = Date.now();
        await page.goto(`http://localhost:${PORT}/`, { waitUntil: "commit", timeout: 90000 });
        const ok = await page.waitForFunction((href) => {
          const spans = Array.from(document.querySelectorAll("span"))
            .filter((s) => s.textContent && s.textContent.trim() === "MY TEAM");
          for (const s of spans) {
            let el = s.parentElement;
            for (let i = 0; i < 10 && el; i++) {
              if (el.querySelector(`a[href="${href}"]`)) return true;
              el = el.parentElement;
            }
          }
          return false;
        }, gameHref, { timeout: 60000 }).then(() => true).catch(() => false);
        if (!ok) fail("MY TEAM 경기 카드 미렌더 — 측정 무효 (fail-close)");
        times.push(Date.now() - t0);
        await ctx.close();
      }
    } finally {
      await browser.close();
    }

    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    console.log(`buildId=${buildId} latency=${LATENCY_MS}ms 대상=${gameHref}`);
    console.log(`홈 진입→MY TEAM 카드: runs=${JSON.stringify(times)}ms median=${median}ms`);
  } finally {
    await stopServer(server);
  }
}

main().catch((e) => fail(String(e?.message || e)));
