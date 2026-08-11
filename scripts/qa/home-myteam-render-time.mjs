#!/usr/bin/env node
/**
 * 홈 진입 → MY TEAM 경기 카드 렌더 시간 측정 (개선 전/후 근거용, 게이트 아님·워크플로 미결속)
 *
 * 배경(2026-08-11, #infra "서비스 속도"): 실기기 16초 중 최대 덩어리가 "홈이 다 채워질
 * 때까지"였고, 코드상 원인은 useHomeInit 온보딩 초기화 effect 의 `if (loading) return`
 * — 인증 확인(세션 복원→profile 페치)이 끝나야 localStorage 마이팀을 그렸다.
 *
 * 측정 계약:
 * - production build(`npx next build`) + `next start` 를 실브라우저(Chromium 390px)로 잰다.
 * - 비로그인 + localStorage(`kbo-my-team`, `kbo-onboarding-status=completed`) 주입.
 *   오늘 실경기에서 마이팀을 고른다(경기 없는 날 fail-close).
 * - `--latency <ms>` 로 CDP 네트워크 에뮬레이션(모바일 RTT 재현).
 * - 1회 = navigation 시작 → "MY TEAM" 배지에서 올라가 찾은 /games/* 앵커가 DOM 에
 *   나타날 때까지. N회 중앙값. 카드 미렌더는 fail-close.
 * - ⚠️ 비로그인 경로의 측정이다. 로그인 사용자는 profile 페치가 게이트라 개선폭이
 *   더 크지만, 로그인 상태 재현은 실계정 E2E(전용 테스트 계정)로 별도 검증한다.
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

async function main() {
  if (!existsSync(path.join(ROOT, ".next"))) fail(".next 없음 — npx next build 후 실행");
  const buildId = readFileSync(path.join(ROOT, ".next/BUILD_ID"), "utf8").trim();

  const probe = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) })
    .then(() => true).catch(() => false);
  if (probe) fail(`포트 ${PORT} 이미 사용 중 — 무엇을 측정하는지 보장 불가`);

  const server = spawn("npx", ["next", "start", "-p", String(PORT)], { cwd: ROOT, stdio: "pipe" });
  let serverDead = false;
  server.on("exit", () => { serverDead = true; });
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      if (serverDead) fail("next start 조기 종료");
      up = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) })
        .then(r => r.ok).catch(() => false);
      if (up) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!up) fail("서버 기동 실패");

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
            downloadThroughput: (4 * 1024 * 1024) / 8, uploadThroughput: (1 * 1024 * 1024) / 8,
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
    server.kill("SIGTERM");
  }
}

main().catch((e) => fail(String(e?.message || e)));
