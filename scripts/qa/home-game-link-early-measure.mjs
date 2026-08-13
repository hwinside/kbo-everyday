#!/usr/bin/env node
/**
 * TeamCard fan-out 과 MY TEAM 경기 링크의 결합 여부를 실측한다.
 *
 * 2026-08-11 #infra 서비스 속도: `/api/team-card` 응답을 4초 지연시킨 상태에서
 * 홈 진입→MY TEAM 경기 링크 클릭 가능 시점을 잰다. head 는 gameSlot 을 `loaded`
 * 바깥에 두므로 지연과 무관해야 하고, base 는 지연만큼 늦어야 한다.
 *
 * 사용: node scripts/qa/home-game-link-early-measure.mjs [--port 4017] [--runs 5]
 * 선행: npm ci && npx next build
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(arg("--port") || 4017);
const RUNS = Number(arg("--runs") || 5);
const TEAM_CARD_DELAY_MS = Number(arg("--team-card-delay") || 4000);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function fail(message) { throw new Error(`MEASURE-FAIL ${message}`); }
function yyyymmddKst() {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
}
async function portInUse() {
  return fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1200) })
    .then(() => true).catch(() => false);
}
function startServer() {
  const child = spawn(path.join(ROOT, "node_modules/.bin/next"), ["start", "-p", String(PORT)], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env },
  });
  child.exited = false;
  child.on("exit", () => { child.exited = true; });
  return child;
}
function signalTree(child, sig) {
  try { process.kill(-child.pid, sig); return; } catch { /* fallback */ }
  try { child.kill(sig); } catch { /* dead */ }
}
async function stopServer(child) {
  signalTree(child, "SIGTERM");
  for (let i = 0; i < 20; i++) {
    if (!(await portInUse())) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  signalTree(child, "SIGKILL");
  for (let i = 0; i < 10; i++) {
    if (!(await portInUse())) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  fail(`포트 ${PORT} 해제 실패`);
}

// #1154 최종 판정과 동일: MY TEAM 배지에서 올라가 게임 앵커가 처음 나타나는 조상을
// 카드 경계로 보고, 그 경계의 고유 앵커 집합이 정확히 {href} 일 때만 인정.
const myTeamGameReady = (href) => {
  const badges = [...document.querySelectorAll("span")]
    .filter((s) => s.textContent?.trim() === "MY TEAM");
  for (const badge of badges) {
    let el = badge.parentElement;
    for (let i = 0; i < 12 && el && el !== document.body && el !== document.documentElement; i++) {
      const hrefs = [...el.querySelectorAll('a[href^="/games/"]')]
        .map((a) => a.getAttribute("href"));
      if (hrefs.length) {
        const unique = [...new Set(hrefs)];
        return unique.length === 1 && unique[0] === href;
      }
      el = el.parentElement;
    }
  }
  return false;
};

async function main() {
  if (!existsSync(path.join(ROOT, ".next/BUILD_ID"))) fail(".next/BUILD_ID 없음");
  if (await portInUse()) fail(`포트 ${PORT} 선점`);
  const buildId = readFileSync(path.join(ROOT, ".next/BUILD_ID"), "utf8").trim();
  const server = startServer();
  try {
    let ready = false;
    for (let i = 0; i < 75; i++) {
      if (server.exited) fail("next-server 조기 종료");
      ready = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok).catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 800));
    }
    if (!ready) fail("서버 기동 실패");
    const html = await (await fetch(`http://localhost:${PORT}/`)).text();
    if (!html.includes(buildId)) fail(`served buildId != ${buildId}`);

    const gameData = await (await fetch(`http://localhost:${PORT}/api/games?date=${yyyymmddKst()}`)).json();
    const game = gameData?.games?.[0];
    if (!game) fail("오늘 경기 없음 — 측정 불가");
    const href = `/games/${game.gameId}`;
    const teamId = game.homeTeamId;

    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const times = [];
    try {
      for (let run = 0; run < RUNS; run++) {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const page = await ctx.newPage();
        await page.addInitScript(([id]) => {
          localStorage.setItem("kbo-my-team", String(id));
          localStorage.setItem("kbo-onboarding-status", "completed");
        }, [teamId]);
        let teamCardSettledAt = 0;
        await page.route("**/api/team-card?*", async (route) => {
          await new Promise((r) => setTimeout(r, TEAM_CARD_DELAY_MS));
          teamCardSettledAt = Date.now();
          await route.continue();
        });
        const t0 = Date.now();
        await page.goto(`http://localhost:${PORT}/`, { waitUntil: "commit", timeout: 90000 });
        const ok = await page.waitForFunction(myTeamGameReady, href, { timeout: 60000 })
          .then(() => true).catch(() => false);
        if (!ok) fail("MY TEAM 경기 링크 미렌더");
        const linkAt = Date.now();
        const beforeTeamCardSettled = !teamCardSettledAt || linkAt < teamCardSettledAt;
        // fan-out 완료(성공/빈 응답/실패) 이후에도 링크가 유지되는지 확인.
        await page.waitForTimeout(TEAM_CARD_DELAY_MS + 800);
        const persists = await page.evaluate(myTeamGameReady, href);
        if (!persists) fail("team-card settle 후 MY TEAM 경기 링크 소실");
        times.push({ ms: linkAt - t0, beforeTeamCardSettled, persistsAfterSettle: persists });
        await ctx.close();
      }
    } finally {
      await browser.close();
    }
    const sorted = times.map((x) => x.ms).sort((a, b) => a - b);
    console.log(`buildId=${buildId} target=${href} teamCardDelay=${TEAM_CARD_DELAY_MS}ms`);
    console.log(`runs=${JSON.stringify(times)} median=${sorted[Math.floor(sorted.length / 2)]}ms`);
  } finally {
    await stopServer(server);
  }
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
