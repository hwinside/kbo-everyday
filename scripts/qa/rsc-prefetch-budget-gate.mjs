#!/usr/bin/env node
/**
 * `_rsc` prefetch 예산 게이트 — production build 실브라우저 측정.
 *
 * 배경 (2026-08-05 production 실측, Playwright 390px):
 * 홈 1회 로드 keubo.fan 요청 131건 중 `_rsc` prefetch 가 56건. `/api/*` 는 2건뿐이었다.
 * 스크롤 3왕복 시 72건 / 고유 22개 = 중복률 69%.
 * 그중 26건은 동적 라우트라 origin function 까지 태운다(MISS/BYPASS 실측).
 *
 * ⚠️ 이전 판(삼순 NO-GO 2026-08-05)이 왜 무효였나:
 * 9개 파일의 **소스 문자열**만 스캔했다. 그래서 신규 Link mutation 이
 * `// <Link href="/x">신규</Link>` 라는 **주석 한 줄을 세어** RED 가 됐다 — 실제
 * 렌더 트리와 무관한 가짜 RED 였다. 또 소스에 `prefetch={false}` 가 있어도 그게
 * 빌드된 앱에서 실제로 prefetch 를 막는지는 증명하지 못했다.
 *
 * 그래서 이 게이트는 **실제 production build 를 띄우고 Chromium 으로 잰다**:
 *   ① 홈 로드 직후 `_rsc` 요청 수 <= RSC_BUDGET_LOAD
 *   ② 스크롤 3왕복 후 누적 `_rsc` 요청 수 <= RSC_BUDGET_SCROLL
 *   ③ origin function 을 태우는 `_rsc`(x-vercel-cache MISS/BYPASS 대응: 로컬은
 *      전부 origin 이므로 총량으로 갈음) 도 같은 예산 안
 *
 * ⚠️ `experimental.staleTimes.dynamic` 은 해법이 아니다:
 * `0 → 30` 으로 올려 동일 방식 production build A/B 했으나 **56 → 56건, 중복률 69%
 * 동일**. 효과 0이라 폐기했다. 실제로 듣는 축은 `prefetch={false}` 뿐이었다(56 → 1).
 *
 * 브라우저·서버가 없는 환경(Vercel prebuild 등)에서는 **SKIP 이 아니라 fail-close**
 * 하지 않고, `--require-browser` 로 실행할 때만 강제한다. CI workflow 는
 * `--require-browser` 로 호출해 Chromium 부재를 FAIL 로 만든다(8/4 SKIP false-green 축).
 *
 * `--selftest` 는 mutation 후 재빌드까지 수행한다(느리지만 진짜 RED 증명).
 *
 * ⚠️ 자기적발(2026-08-05): 첫 판은 포트가 이미 점유돼 있으면 `next start` 가 즉시 죽고
 * **다른 빌드의 stale 서버**를 그대로 측정했다. 그래서 TabBar mutation 이 `_rsc 0건`
 * 으로 GREEN 통과했다 — 측정 대상이 mutation 산출물이 아니었다.
 * 지금은 ①시작 전 포트 점유를 fail-close ②서버 프로세스 조기 종료를 fail-close
 * ③빌드 지문(buildId)이 방금 만든 `.next` 와 일치하는지 확인해 stale 측정을 막는다.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "../..");

const RSC_BUDGET_LOAD = 6;
const RSC_BUDGET_SCROLL = 10;
const PORT = Number(process.env.RSC_GATE_PORT || 3199);

const REQUIRE_BROWSER = process.argv.includes("--require-browser");

function log(...a) { console.log(...a); }

async function loadChromium() {
  try {
    const { chromium } = await import("playwright");
    return chromium;
  } catch {
    return null;
  }
}

/**
 * 포트가 이미 살아 있으면 fail-close.
 * 이게 없으면 `next start` 가 EADDRINUSE 로 죽고, 이 게이트는 그 포트에 떠 있던
 * **다른 빌드**를 측정한다(= 무엇을 측정했는지 모르는 GREEN).
 */
async function portBusy() {
  try {
    await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

/** 방금 빌드한 산출물의 buildId. 서버가 이 값을 서빙해야 stale 이 아니다. */
function localBuildId() {
  try {
    return readFileSync(path.join(ROOT, ".next/BUILD_ID"), "utf8").trim();
  } catch {
    return null;
  }
}

function startServer() {
  const child = spawn("npx", ["next", "start", "-p", String(PORT)], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env },
  });
  child.__exited = false;
  child.on("exit", () => { child.__exited = true; });
  return child;
}

async function waitReady(child, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child.__exited) return "server-exited";
    try {
      const r = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  return "timeout";
}

/**
 * 서빙 중인 앱이 방금 빌드한 산출물인지 확인한다.
 * Next 는 스크립트 URL 에 buildId 를 넣으므로 HTML 에서 찾을 수 있다.
 */
async function servedBuildIdMatches(expected) {
  if (!expected) return { ok: false, reason: ".next/BUILD_ID 를 읽지 못했다" };
  try {
    const html = await (await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(10000) })).text();
    if (html.includes(expected)) return { ok: true };
    return { ok: false, reason: `서빙 중인 앱에 로컬 buildId(${expected}) 가 없다 — stale 서버 측정 의심` };
  } catch (e) {
    return { ok: false, reason: `buildId 확인 실패: ${e.message}` };
  }
}

/** 실브라우저로 홈 로드 + 스크롤 3왕복 동안 `_rsc` 요청을 센다. */
async function measure(chromium) {
  const base = `http://localhost:${PORT}`;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const rsc = [];
    page.on("request", (r) => {
      const u = r.url();
      if (u.startsWith(base) && u.includes("_rsc=")) rsc.push(u.slice(base.length).split("?")[0]);
    });
    await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(6000);
    const load = rsc.length;
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 4000); await page.waitForTimeout(1200);
      await page.mouse.wheel(0, -4000); await page.waitForTimeout(1200);
    }
    await page.waitForTimeout(2000);
    const scroll = rsc.length;
    // 실제 마운트된 내비 Link 가 존재하는지(= 측정 대상이 실재하는지) 확인.
    // 이게 없으면 "Link 가 안 그려져서 _rsc 0" 인 false-green 을 못 막는다.
    const navLinks = await page.evaluate(() =>
      ["/standings", "/players", "/teams", "/games", "/my"]
        .filter((h) => !!document.querySelector(`a[href="${h}"]`)).length);
    await ctx.close();
    return { load, scroll, navLinks, paths: rsc };
  } finally {
    await browser.close();
  }
}

function judge(m) {
  const fails = [];
  if (m.navLinks < 4)
    fails.push(`마운트된 내비 Link ${m.navLinks}개(<4) — 페이지가 제대로 안 그려졌다. 측정 무효`);
  if (m.load > RSC_BUDGET_LOAD)
    fails.push(`홈 로드 직후 _rsc ${m.load}건 > 예산 ${RSC_BUDGET_LOAD}`);
  if (m.scroll > RSC_BUDGET_SCROLL)
    fails.push(`스크롤 3왕복 후 _rsc ${m.scroll}건 > 예산 ${RSC_BUDGET_SCROLL}`);
  return fails;
}

async function runOnce() {
  const chromium = await loadChromium();
  if (!chromium) {
    if (REQUIRE_BROWSER) {
      log("FAIL Chromium(playwright) 없음 — --require-browser 이므로 fail-close");
      return 1;
    }
    log("SKIP Chromium 없음 (CI 는 --require-browser 로 실행해 fail-close)");
    return 0;
  }
  if (!existsSync(path.join(ROOT, ".next"))) {
    log("FAIL .next 빌드 산출물 없음 — production build 후 실행해야 한다");
    return 1;
  }
  if (await portBusy()) {
    log(`FAIL 포트 ${PORT} 가 이미 사용 중 — 다른 빌드를 측정할 수 있어 fail-close (RSC_GATE_PORT 로 변경 가능)`);
    return 1;
  }
  const expectedBuildId = localBuildId();
  const server = startServer();
  try {
    const ready = await waitReady(server);
    if (ready !== true) { log(`FAIL next start 준비 실패 (${ready})`); return 1; }
    const idCheck = await servedBuildIdMatches(expectedBuildId);
    if (!idCheck.ok) { log(`FAIL ${idCheck.reason}`); return 1; }
    log(`  buildId ${expectedBuildId} 일치 (방금 빌드한 산출물을 측정)`);
    const m = await measure(chromium);
    log(`  마운트된 내비 Link ${m.navLinks}/5`);
    log(`  홈 로드 직후 _rsc ${m.load}건 (예산 ${RSC_BUDGET_LOAD})`);
    log(`  스크롤 3왕복 후  _rsc ${m.scroll}건 (예산 ${RSC_BUDGET_SCROLL})`);
    const uniq = new Set(m.paths);
    log(`  고유 경로 ${uniq.size}개`);
    const fails = judge(m);
    for (const f of fails) log(`  FAIL ${f}`);
    if (!fails.length) log("  PASS 예산 이내");
    return fails.length ? 1 : 0;
  } finally {
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 800));
  }
}

/** mutation: 실제 소스에서 prefetch 를 되돌린 뒤 재빌드해 RED 를 증명한다. */
const MUTATIONS = [
  {
    name: "A. TabBar prefetch 제거(기본값 복귀)",
    file: "src/components/ui/TabBar.tsx",
    apply: (s) => s.replace(/<Link prefetch=\{false\}/g, "<Link"),
  },
  {
    name: "B. 홈 최신글 prefetch 제거",
    file: "src/components/home/CommunityLatestPosts.tsx",
    apply: (s) => s.replace(/<Link prefetch=\{false\}/g, "<Link"),
  },
  {
    name: "C. 경기 카드 prefetch={true} 로 뒤집음",
    file: "src/components/home/TodayGamesSection.tsx",
    apply: (s) => s.replace(/prefetch=\{false\}/g, "prefetch={true}"),
  },
];

function build() {
  const r = spawnSync("npx", ["next", "build"], {
    cwd: ROOT, stdio: "ignore", env: { ...process.env, SKIP_PREBUILD: "1" },
  });
  return r.status === 0;
}

async function selftest() {
  log("=== selftest: mutation 후 재빌드 → 실브라우저 RED 증명 ===");
  const chromium = await loadChromium();
  if (!chromium) { log("FAIL Chromium 없음 — selftest 불가"); process.exit(1); }

  log("\n[0] baseline 재빌드");
  if (!build()) { log("FAIL baseline build 실패"); process.exit(1); }
  const base = await runOnce();
  if (base !== 0) { log("FAIL baseline 이 이미 RED — mutation 검증 불가"); process.exit(1); }

  let bad = 0;
  for (const mut of MUTATIONS) {
    const abs = path.join(ROOT, mut.file);
    const original = readFileSync(abs, "utf8");
    const mutated = mut.apply(original);
    if (mutated === original) {
      log(`\n--- ${mut.name} ---\n  FAIL mutation 이 소스를 못 바꿨다(anchor 불일치) — 검증력 0`);
      bad++;
      continue;
    }
    log(`\n--- ${mut.name} ---`);
    writeFileSync(abs, mutated);
    try {
      if (!build()) { log("  FAIL mutated build 실패"); bad++; continue; }
      const code = await runOnce();
      if (code === 0) { log("  ❌ 이 mutation 이 RED 를 못 만들었다 — 게이트 검증력 없음"); bad++; }
      else log("  ✅ RED");
    } finally {
      writeFileSync(abs, original);
      const back = readFileSync(abs, "utf8");
      if (back !== original) { log("  FAIL 원본 복원 실패(오염)"); bad++; }
    }
  }

  log("\n[Z] 원본 복원 후 재빌드 + baseline 재확인");
  if (!build()) { log("FAIL 복원 build 실패"); process.exit(1); }
  const after = await runOnce();
  if (after !== 0) { log("FAIL 복원 후 baseline 이 RED — 오염"); process.exit(1); }

  log(`\nselftest 결과: 검증력 없는 mutation ${bad}건`);
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv.includes("--selftest")) {
  await selftest();
} else {
  log("=== _rsc prefetch 예산 게이트 (production build 실브라우저) ===");
  process.exit(await runOnce());
}
