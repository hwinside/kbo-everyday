#!/usr/bin/env node
/**
 * /players 마이팀 디폴트 브라우저 게이트.
 *
 * 왜 별도 게이트인가:
 *   players-sort-browser.mjs 는 마이팀 모듈을 `getMyTeamId = () => null` 스텁으로
 *   고정한다(정렬 축을 흐리지 않기 위해). 그래서 "마이팀이 있을 때 무엇이 보이는가"
 *   는 그 게이트가 단 한 줄도 증명하지 못한다. 여기서는 **실물 myteam 모듈**을
 *   그대로 태우고 localStorage/cookie/늦은 도착을 실제 브라우저에서 만든다.
 *
 * 검증 축 (2026-08-15 Production 실측 결함 그대로):
 *   M1 localStorage 에 마이팀 → 구단별 + 마이팀으로 뜬다
 *   M2 **쿠키에만** 마이팀     → 그래도 마이팀으로 뜬다 (localStorage 만 보면 전체 883명)
 *   M3 **늦게 도착한 마이팀**  → team-changed 후 마이팀으로 전환 (로그인 유저 경로)
 *   M4 마이팀 없음             → 전체
 *   M5 URL 이 명시한 필터      → 마이팀이 덮어쓰지 않는다
 *   M6 유저가 만진 필터        → 늦게 온 마이팀이 덮어쓰지 않는다
 *
 * 실행: node scripts/qa/players-myteam-default-browser.mjs
 * 자기검증: MYTEAM_MUTATE=<cookie|late|touched|urlwin> 주입 시 대응 축이 RED 여야 한다.
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import playwright from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REQUIRE_BROWSER = process.env.MYTEAM_REQUIRE_BROWSER === "1";
const MUTATE = process.env.MYTEAM_MUTATE ?? "";
const chromiumPath = playwright.chromium.executablePath();
if (!existsSync(chromiumPath)) {
  if (REQUIRE_BROWSER) {
    console.error(`FAIL: playwright chromium not found at ${chromiumPath}`);
    process.exit(1);
  }
  console.log(`SKIP: playwright chromium not found at ${chromiumPath}`);
  process.exit(0);
}

const ROOT = process.cwd();
const GEN = mkdtempSync(resolve(tmpdir(), "players-myteam-"));
const pagePath = resolve(ROOT, "src/app/(main)/players/page.tsx");
const storePath = resolve(ROOT, "src/lib/store/myteam.ts");

// ── 결함 주입 ───────────────────────────────────────────────────────────────
// 앵커가 드리프트하면 즉시 throw — 게이트가 조용히 무의미해지는 것을 막는다.
let pageEntry = pagePath;
let storeEntry = storePath;
if (MUTATE) {
  const pageSrc = readFileSync(pagePath, "utf8");
  const storeSrc = readFileSync(storePath, "utf8");
  // [파일, from, to]
  const mutations = {
    // cookie: 쿠키 폴백 제거 → M2 RED (수정 전 원래 코드 그대로)
    cookie: [[
      "store",
      "  const parsed = parseTeamId(fromStorage);\n  if (parsed !== null) return parsed;\n  return parseTeamId(readCookie(STORAGE_KEY));",
      "  return parseTeamId(fromStorage);",
    ]],
    // late: 늦게 도착한 마이팀 구독 제거 → M3 RED (수정 전 원래 코드 그대로)
    late: [[
      "page",
      '    apply();\n    window.addEventListener("team-changed", apply);\n    window.addEventListener("storage", apply);',
      "    apply();",
    ]],
    // touched: 유저 조작 가드 제거 → M6 RED (늦게 온 마이팀이 유저 선택을 덮어씀)
    touched: [[
      "page",
      "        if (!hasUrlMode && !hasUrlTeam && !filterTouchedRef.current) {",
      "        if (!hasUrlMode && !hasUrlTeam) {",
    ]],
    // urlwin: URL 명시 필터 가드 제거 → M5 RED
    urlwin: [[
      "page",
      "        if (!hasUrlMode && !hasUrlTeam && !filterTouchedRef.current) {",
      "        if (!filterTouchedRef.current) {",
    ]],
  };
  const steps = mutations[MUTATE];
  if (!steps) throw new Error(`unknown mutation: ${MUTATE}`);
  let page = pageSrc;
  let store = storeSrc;
  for (const [target, from, to] of steps) {
    const src = target === "page" ? page : store;
    if (src.split(from).length - 1 !== 1) {
      throw new Error(`mutation anchor drifted (${MUTATE}/${target}) — 앵커를 갱신하지 않으면 이 게이트는 무의미하다`);
    }
    if (target === "page") page = page.replace(from, to);
    else store = store.replace(from, to);
  }
  if (page !== pageSrc) {
    pageEntry = resolve(GEN, "players-page-mutated.tsx");
    writeFileSync(pageEntry, page);
  }
  if (store !== storeSrc) {
    storeEntry = resolve(GEN, "myteam-mutated.ts");
    writeFileSync(storeEntry, store);
  }
}

// ── 스텁 ────────────────────────────────────────────────────────────────────
// 라우팅·이미지만 걷어낸다. **myteam 은 스텁하지 않는다** — 이 게이트의 대상이다.
writeFileSync(resolve(GEN, "navigation.jsx"), `
let current = new URLSearchParams(window.__QS__ || "");
export const useSearchParams = () => current;
export const useRouter = () => ({
  replace: (url) => { window.__LAST_URL__ = url; },
  push: () => {}, back: () => {}, prefetch: () => {},
});
export const usePathname = () => "/players";`);
writeFileSync(resolve(GEN, "link.jsx"), `
import React from "react";
export default function Link({ href, children, prefetch, ...rest }) {
  return React.createElement("a", { href, ...rest }, children);
}`);
writeFileSync(resolve(GEN, "empty.jsx"), `export default function Empty(){return null;}`);
writeFileSync(resolve(GEN, "avatar.jsx"), `
export default function Avatar({name}){return <span aria-hidden="true">B</span>;}`);
writeFileSync(resolve(GEN, "badge.jsx"), `
export default function Badge({teamId}){return <span>팀{teamId}</span>;}`);
writeFileSync(resolve(GEN, "safeback.jsx"), `
export const useSafeBack = () => () => {};`);
writeFileSync(resolve(GEN, "entry.jsx"), `
import React from "react";
import {createRoot} from "react-dom/client";
import PlayersPage from "@/app/(main)/players/page";
createRoot(document.getElementById("root")).render(<PlayersPage />);`);

const alias = {
  "@/app/(main)/players/page": pageEntry,
  "next/navigation": resolve(GEN, "navigation.jsx"),
  "next/link": resolve(GEN, "link.jsx"),
  "@/components/ui/HeaderProfileLink": resolve(GEN, "empty.jsx"),
  "@/components/ui/PlayerAvatar": resolve(GEN, "avatar.jsx"),
  "@/components/ui/TeamBadge": resolve(GEN, "badge.jsx"),
  "@/lib/hooks/useSafeBack": resolve(GEN, "safeback.jsx"),
};
if (storeEntry !== storePath) alias["@/lib/store/myteam"] = storeEntry;

await build({
  entryPoints: [resolve(GEN, "entry.jsx")], bundle: true, format: "iife",
  outfile: resolve(GEN, "bundle.js"), jsx: "automatic", absWorkingDir: ROOT,
  nodePaths: [resolve(ROOT, "node_modules")], tsconfig: resolve(ROOT, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".json": "json" },
  alias, logLevel: "error",
});

const globals = resolve(ROOT, "src/styles/globals.css");
const css = (await postcss([tailwind]).process(
  `@source "${pageEntry}";\n${readFileSync(globals, "utf8")}`,
  { from: globals },
)).css;
const bundle = readFileSync(resolve(GEN, "bundle.js"), "utf8");
const pageHtml = (qs) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style><div id="root"></div>
<script>window.__QS__=${JSON.stringify(qs)};</script>
<script>${bundle}</script>`;

const server = createServer((req, res) => {
  const qs = (req.url || "").split("?")[1] ?? "";
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(pageHtml(qs));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;

// ── fixture 는 실물 roster 에서 파생한다 (지어낸 값 금지) ────────────────────
const rosterFull = JSON.parse(readFileSync(resolve(ROOT, "src/lib/constants/players-roster.json"), "utf8"));
const teamCounts = new Map();
for (const p of rosterFull) teamCounts.set(p.teamId, (teamCounts.get(p.teamId) ?? 0) + 1);
const [MY_TEAM_ID, MY_TEAM_SIZE] = [...teamCounts.entries()].sort((a, b) => b[1] - a[1])[0];
const OTHER_TEAM_ID = [...teamCounts.keys()].find((id) => id !== MY_TEAM_ID);
const TOTAL = rosterFull.length;
if (!MY_TEAM_ID || MY_TEAM_SIZE < 10 || !OTHER_TEAM_ID) throw new Error("팀 fixture 추출 실패");

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) { console.log(`  ✅ ${label}`); return; }
  failures += 1;
  console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
};

const ROW = '[data-testid="players-list"] > a';
// 화면에 뜬 목록이 "누구의" 목록인지 카운트 라벨이 아니라 **행의 소속**으로 판정한다.
// (카운트만 보면 목록이 안 그려져도 통과한다)
const shownTeams = (page) =>
  page.$$eval(ROW, (nodes) => nodes.map((n) => (n.textContent ?? "").match(/팀(\d+)/)?.[1] ?? "?"));
const countLabel = (page) =>
  page.locator('[data-testid="players-count"]').innerText()
    .then((t) => Number((t.match(/(\d+)명/) ?? [])[1] ?? 0)).catch(() => 0);

const routeStubs = async (page) => {
  // roster 는 정적 JSON 폴백을 그대로 쓰게 두고(실물 로스터가 fixture 의 근거),
  // 인기 집계는 즉시 빈 counts 로 settle 시켜 정렬 축이 이 게이트를 흐리지 않게 한다.
  await page.route("**/api/roster", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/player-popularity", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ counts: {} }) }));
};

const browser = await playwright.chromium.launch({ headless: true });
try {
  const origin = `http://127.0.0.1:${port}`;

  // ── M1: localStorage 에 마이팀 ────────────────────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(`localStorage.setItem("kbo-my-team", ${JSON.stringify(String(MY_TEAM_ID))});`);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => { failures += 1; console.error(`BROWSER_PAGE_ERROR: ${e.message}`); });
    await routeStubs(page);
    await page.goto(`${origin}/`);
    await page.waitForSelector(ROW, { timeout: 5000 });
    await page.waitForTimeout(400);
    const teams = await shownTeams(page);
    const n = await countLabel(page);
    check(
      "M1 localStorage 마이팀 → 마이팀 목록으로 뜬다",
      teams.length > 0 && teams.every((t) => t === String(MY_TEAM_ID)) && n === MY_TEAM_SIZE,
      `count=${n} expected=${MY_TEAM_SIZE} teams=${JSON.stringify([...new Set(teams)])}`,
    );
    await ctx.close();
  }

  // ── M2: 쿠키에만 마이팀 (2026-08-15 Production 결함) ──────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addCookies([{ name: "kbo-my-team", value: String(MY_TEAM_ID), url: origin }]);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => { failures += 1; console.error(`BROWSER_PAGE_ERROR: ${e.message}`); });
    await routeStubs(page);
    await page.goto(`${origin}/`);
    await page.waitForSelector(ROW, { timeout: 5000 });
    await page.waitForTimeout(400);
    const teams = await shownTeams(page);
    const n = await countLabel(page);
    check(
      "M2 쿠키에만 마이팀이어도 마이팀 목록으로 뜬다(localStorage 소실 경로)",
      teams.length > 0 && teams.every((t) => t === String(MY_TEAM_ID)) && n === MY_TEAM_SIZE,
      `count=${n} expected=${MY_TEAM_SIZE} total=${TOTAL}`,
    );
    await ctx.close();
  }

  // ── M3: 늦게 도착한 마이팀 (로그인 유저 경로) ─────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => { failures += 1; console.error(`BROWSER_PAGE_ERROR: ${e.message}`); });
    await routeStubs(page);
    await page.goto(`${origin}/`);
    await page.waitForSelector(ROW, { timeout: 5000 });
    const before = await countLabel(page);
    check("M3a 마이팀 도착 전에는 전체 목록", before === TOTAL, `count=${before} total=${TOTAL}`);

    // AuthContext 가 프로필 응답 뒤 setMyTeamId() 를 부르는 상황 그대로.
    await page.evaluate(([id]) => {
      localStorage.setItem("kbo-my-team", String(id));
      window.dispatchEvent(new Event("team-changed"));
    }, [MY_TEAM_ID]);
    await page.waitForTimeout(600);
    const teams = await shownTeams(page);
    const after = await countLabel(page);
    check(
      "M3 마운트 뒤 도착한 마이팀도 반영된다(무한 전체목록 금지)",
      teams.length > 0 && teams.every((t) => t === String(MY_TEAM_ID)) && after === MY_TEAM_SIZE,
      `${before} -> ${after} expected=${MY_TEAM_SIZE}`,
    );
    await ctx.close();
  }

  // ── M4: 마이팀 없음 → 전체 ───────────────────────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => { failures += 1; console.error(`BROWSER_PAGE_ERROR: ${e.message}`); });
    await routeStubs(page);
    await page.goto(`${origin}/`);
    await page.waitForSelector(ROW, { timeout: 5000 });
    await page.waitForTimeout(400);
    const n = await countLabel(page);
    check("M4 마이팀 미지정이면 전체", n === TOTAL, `count=${n} total=${TOTAL}`);
    await ctx.close();
  }

  // ── M5: URL 이 명시한 필터를 마이팀이 덮어쓰지 않는다 ────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(`localStorage.setItem("kbo-my-team", ${JSON.stringify(String(MY_TEAM_ID))});`);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => { failures += 1; console.error(`BROWSER_PAGE_ERROR: ${e.message}`); });
    await routeStubs(page);
    await page.goto(`${origin}/?mode=team&team=${OTHER_TEAM_ID}`);
    await page.waitForSelector(ROW, { timeout: 5000 });
    await page.waitForTimeout(400);
    const teams = await shownTeams(page);
    check(
      "M5 URL 이 지정한 구단을 마이팀이 덮어쓰지 않는다",
      teams.length > 0 && teams.every((t) => t === String(OTHER_TEAM_ID)),
      `url_team=${OTHER_TEAM_ID} shown=${JSON.stringify([...new Set(teams)])}`,
    );
    await ctx.close();
  }

  // ── M6: 유저가 만진 필터를 늦게 온 마이팀이 덮어쓰지 않는다 ──────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => { failures += 1; console.error(`BROWSER_PAGE_ERROR: ${e.message}`); });
    await routeStubs(page);
    await page.goto(`${origin}/`);
    await page.waitForSelector(ROW, { timeout: 5000 });

    // 유저가 직접 다른 구단을 고른다.
    await page.getByRole("button", { name: "구단별", exact: true }).click();
    await page.waitForTimeout(150);
    const otherLabel = rosterFull.find((p) => p.teamId === OTHER_TEAM_ID)?.team;
    await page.locator('button[class*="shrink-0"]', { hasText: otherLabel }).first().click();
    await page.waitForTimeout(250);
    const picked = await shownTeams(page);
    check(
      "M6a 유저가 고른 구단이 실제로 적용된다",
      picked.length > 0 && picked.every((t) => t === String(OTHER_TEAM_ID)),
      `shown=${JSON.stringify([...new Set(picked)])}`,
    );

    // 그 뒤에 마이팀이 도착한다 — 유저 선택을 뒤엎으면 안 된다.
    await page.evaluate(([id]) => {
      localStorage.setItem("kbo-my-team", String(id));
      window.dispatchEvent(new Event("team-changed"));
    }, [MY_TEAM_ID]);
    await page.waitForTimeout(600);
    const after = await shownTeams(page);
    check(
      "M6 늦게 온 마이팀이 유저가 만진 필터를 덮어쓰지 않는다",
      after.length > 0 && after.every((t) => t === String(OTHER_TEAM_ID)),
      `expected=${OTHER_TEAM_ID} shown=${JSON.stringify([...new Set(after)])}`,
    );
    await ctx.close();
  }
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  rmSync(GEN, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`FAIL players myteam default: ${failures} check(s) failed${MUTATE ? ` (mutation=${MUTATE})` : ""}`);
  process.exit(1);
}
console.log(`PASS players myteam default: localstorage + cookie_fallback + late_arrival + none + url_wins + user_touch${MUTATE ? ` (mutation=${MUTATE} NOT detected — 게이트 결함)` : ""}`);
