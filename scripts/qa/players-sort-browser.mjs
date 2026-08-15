#!/usr/bin/env node
/**
 * /players 정렬 토글 브라우저 게이트.
 *
 * 왜 별도 게이트인가 (삼순 2026-08-15 NO-GO):
 *   player-popularity-order-smoke 의 `/players` 축은 전부 **소스 regex** 라
 *   "정렬 함수를 부르는 코드가 있다" 까지만 본다. 실제로 화면에 어떤 순서로
 *   그려지는지, 집계가 늦게 도착할 때 행이 튀는지, 구 URL 로 들어오면 무엇이
 *   보이는지는 하나도 증명하지 못한다. 이 스크립트는 실제 페이지를 마운트해
 *   DOM 순서와 상호작용을 직접 본다.
 *
 * 검증 축:
 *   B1 인기순 기본  — 집계 도착 후 지정수 desc 순서로 렌더
 *   B2 재정렬 금지  — 집계가 늦게 와도 이미 보인 행이 움직이지 않는다(터치·스크롤 중 오클릭 방지)
 *   B3 집계 실패    — 500 이어도 목록이 살아있고 가나다순
 *   B4 토글 전환    — 가나다순 클릭 시 실제 DOM 순서가 이름순으로 바뀐다
 *   B5 구 딥링크    — ?sort=posts 로 들어와도 빈 화면이 아니라 인기순 기본으로 정규화
 *   B6 검색         — 초성 검색이 목록을 줄인다
 *   B7 무한스크롤   — 최초 20명 → 스크롤 시 증가
 *
 * 실행: node scripts/qa/players-sort-browser.mjs
 * 자기검증: PLAYERS_SORT_MUTATE=<race|toggle|fallback> 로 결함을 주입하면 RED 여야 한다.
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import playwright from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REQUIRE_BROWSER = process.env.PLAYERS_SORT_REQUIRE_BROWSER === "1";
const MUTATE = process.env.PLAYERS_SORT_MUTATE ?? "";
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
const GEN = mkdtempSync(resolve(tmpdir(), "players-sort-browser-"));
const pagePath = resolve(ROOT, "src/app/(main)/players/page.tsx");

// ── 결함 주입 ───────────────────────────────────────────────────────────────
// 게이트가 진짜로 그 결함을 잡는지 증명한다. 앵커가 드리프트하면 즉시 throw.
let pageEntry = pagePath;
if (MUTATE) {
  const source = readFileSync(pagePath, "utf8");
  const mutations = {
    // race: settle 게이트를 없애 빈 counts 로 먼저 그리게 만든다 → B2 RED
    race: [{
      from: 'sortMode === "popularity" && popularityStatus === "loading" ? (',
      to: 'false ? (',
    }],
    // toggle: 가나다순 갈래를 인기순으로 되돌린다 → B4 RED
    toggle: [{
      from: '  return [...players].sort((a, b) => a.name.localeCompare(b.name, "ko"));\n}',
      to: '  return sortPlayersByPopularity(players.map((p) => ({ ...p, id: p.kboId })), popularity);\n}',
    }],
    // fallback: 실패 경로의 settle 을 **둘 다** 제거해야 실제 결함이 된다 → B3 RED.
    //   timeout 과 catch 는 서로의 안전망이라 한 쪽만 지우면 다른 쪽이 덩는다
    //   (defense-in-depth). 한 쪽만 지우고 "게이트가 잡는다" 고 말하면 거짓이다.
    fallback: [
      {
        from: '    const timeout = window.setTimeout(() => {\n      if (stale || settled) return;\n      settled = true;\n      setPopularityStatus("ready");\n    }, 1200);',
        to: '    const timeout = window.setTimeout(() => {}, 1200);',
      },
      {
        from: '        settled = true;\n        setPopularityStatus("ready");\n      });',
        to: '        settled = true;\n      });',
      },
    ],
  };
  const steps = mutations[MUTATE];
  if (!steps) throw new Error(`unknown mutation: ${MUTATE}`);
  let mutated = source;
  for (const step of steps) {
    if (mutated.split(step.from).length - 1 !== 1) {
      throw new Error(`mutation anchor drifted (${MUTATE}) — 앵커를 갱신하지 않으면 이 게이트는 무의미하다`);
    }
    mutated = mutated.replace(step.from, step.to);
  }
  pageEntry = resolve(GEN, "players-page-mutated.tsx");
  writeFileSync(pageEntry, mutated);
}

// ── 스텁 ────────────────────────────────────────────────────────────────────
// 라우팅·인증·이미지만 걷어내고 정렬/검색/필터/스크롤 로직은 실물 그대로 태운다.
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
export default function Avatar({name}){return <span aria-hidden="true">⚾</span>;}`);
writeFileSync(resolve(GEN, "badge.jsx"), `
export default function Badge({teamId}){return <span>팀{teamId}</span>;}`);
writeFileSync(resolve(GEN, "safeback.jsx"), `
export const useSafeBack = () => () => {};`);
writeFileSync(resolve(GEN, "myteam.jsx"), `
// MY TEAM 미지정 상태로 고정 — 팀 디폴트가 걸리면 전체 목록 축이 흐려진다.
export const getMyTeamId = () => null;
export const setMyTeamId = () => {};`);
writeFileSync(resolve(GEN, "entry.jsx"), `
import React from "react";
import {createRoot} from "react-dom/client";
import PlayersPage from "@/app/(main)/players/page";
createRoot(document.getElementById("root")).render(<PlayersPage />);`);

await build({
  entryPoints: [resolve(GEN, "entry.jsx")], bundle: true, format: "iife",
  outfile: resolve(GEN, "bundle.js"), jsx: "automatic", absWorkingDir: ROOT,
  nodePaths: [resolve(ROOT, "node_modules")], tsconfig: resolve(ROOT, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".json": "json" },
  alias: {
    "@/app/(main)/players/page": pageEntry,
    "next/navigation": resolve(GEN, "navigation.jsx"),
    "next/link": resolve(GEN, "link.jsx"),
    "@/components/ui/HeaderProfileLink": resolve(GEN, "empty.jsx"),
    "@/components/ui/PlayerAvatar": resolve(GEN, "avatar.jsx"),
    "@/components/ui/TeamBadge": resolve(GEN, "badge.jsx"),
    "@/lib/hooks/useSafeBack": resolve(GEN, "safeback.jsx"),
    "@/lib/store/myteam": resolve(GEN, "myteam.jsx"),
  }, logLevel: "error",
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

// ── roster 실물에서 fixture 파생 (지어낸 이름 금지) ──────────────────────────
const roster = JSON.parse(readFileSync(resolve(ROOT, "src/lib/constants/players-roster.json"), "utf8"))
  .map((p) => ({ kboId: String(p.kboId), name: p.name }));
const byName = [...roster].sort((a, b) => a.name.localeCompare(b.name, "ko"));
// 가나다순 최상위와 겹치지 않는 실제 선수 3명을 "인기 상위" 로 세운다.
const topAlpha = new Set(byName.slice(0, 30).map((p) => p.kboId));
const boosted = roster.filter((p) => !topAlpha.has(p.kboId)).slice(-3);
if (boosted.length !== 3) throw new Error("fixture 추출 실패 — roster 가 비었나?");
const COUNTS = {
  [boosted[0].kboId]: 900,
  [boosted[1].kboId]: 800,
  [boosted[2].kboId]: 700,
};
const EXPECTED_TOP3 = boosted.map((p) => p.name);
const EXPECTED_ALPHA1 = byName[0].name;

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) { console.log(`  ✅ ${label}`); return; }
  failures += 1;
  console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
};

const ROW = '[data-testid="players-list"] > a';
const rowNames = (page) =>
  page.$$eval(`${ROW} span.text-sm.font-semibold`, (nodes) => nodes.map((n) => n.textContent.trim()));

const browser = await playwright.chromium.launch({ headless: true });
try {
  // ── B1·B2: 인기순 기본 + 늦은 응답 재정렬 금지 ────────────────────────────
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    page.on("pageerror", (e) => { failures += 1; console.error(`BROWSER_PAGE_ERROR: ${e.message}`); });
    await page.route("**/api/roster", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
    await page.route("**/api/player-popularity", async (r) => {
      await new Promise((d) => setTimeout(d, 1500)); // timeout(1200ms) 보다 늦게 → late response
      await r.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ counts: COUNTS, degraded: false }),
      });
    });
    await page.goto(`http://127.0.0.1:${port}/`);

    // settle 전에는 목록이 아니라 로딩이 보여야 한다(빈 counts 로 먼저 그리면 이후 튄다).
    const loadingSeen = await page.locator('[data-testid="players-popularity-loading"]')
      .waitFor({ timeout: 1000 }).then(() => true).catch(() => false);
    check("B2a settle 전에는 목록 대신 로딩 표시(빈 counts 선렌더 금지)", loadingSeen);

    await page.waitForSelector(ROW, { timeout: 5000 });
    // 행을 실제로 터치하되 이동은 막는다 — 이 게이트가 보려는 것은 "누르는 순간 행이
    // 움직이느냐" 이지 라우팅이 아니다. preventDefault 없이 탭하면 페이지가 이퀈해
    // 목록이 빈 배열로 변하고, 그러면 재정렬 여부를 증명하지 못한다.
    await page.evaluate(() => {
      document.addEventListener("click", (e) => {
        if (e.target && e.target.closest && e.target.closest("a")) e.preventDefault();
      }, true);
    });
    const before = await rowNames(page);
    // 늦은 응답이 도착할 시간을 준 뒤, 사용자가 만지는 동안 순서가 바뀌는지 본다.
    await page.locator(ROW).nth(1).tap();
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(1200);
    const after = await rowNames(page);
    check(
      "B2b 늦은 집계 응답이 이미 보인 행을 재정렬하지 않는다",
      JSON.stringify(before.slice(0, 5)) === JSON.stringify(after.slice(0, 5)),
      `${JSON.stringify(before.slice(0, 5))} -> ${JSON.stringify(after.slice(0, 5))}`,
    );
    check(
      "B2c timeout settle 이므로 가나다순으로 확정(늦은 인기순 미적용)",
      before[0] === EXPECTED_ALPHA1,
      `top=${before[0]} expected=${EXPECTED_ALPHA1}`,
    );
    await page.close();
  }

  // ── B1: 집계가 제때 오면 인기순 순서로 렌더 ────────────────────────────────
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    page.on("pageerror", (e) => { failures += 1; console.error(`BROWSER_PAGE_ERROR: ${e.message}`); });
    await page.route("**/api/roster", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
    await page.route("**/api/player-popularity", (r) =>
      r.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ counts: COUNTS, degraded: false }),
      }));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector(ROW, { timeout: 5000 });
    const names = await rowNames(page);
    check(
      "B1 인기순 기본 — 지정수 desc 순서로 렌더",
      JSON.stringify(names.slice(0, 3)) === JSON.stringify(EXPECTED_TOP3),
      `${JSON.stringify(names.slice(0, 3))} expected=${JSON.stringify(EXPECTED_TOP3)}`,
    );
    check("B1b 목록이 잘리지 않고 20명 페이지", names.length === 20, `rows=${names.length}`);

    // ── B4: 가나다순 토글이 실제 DOM 순서를 바꾼다 ──────────────────────────
    await page.getByRole("button", { name: "가나다순" }).click();
    await page.waitForTimeout(200);
    const alpha = await rowNames(page);
    check(
      "B4 가나다순 토글이 실제 순서를 바꾼다",
      alpha[0] === EXPECTED_ALPHA1 && JSON.stringify(alpha.slice(0, 3)) !== JSON.stringify(EXPECTED_TOP3),
      `top=${alpha[0]} expected=${EXPECTED_ALPHA1}`,
    );

    // ── B6: 검색 ────────────────────────────────────────────────────────────
    const target = byName[0].name;
    await page.locator('input[type="text"]').fill(target);
    await page.waitForTimeout(250);
    const searched = await rowNames(page);
    check(
      "B6 검색이 목록을 줄이고 대상 선수를 포함",
      searched.length > 0 && searched.length < 20 && searched.includes(target),
      `rows=${searched.length}`,
    );
    await page.locator('input[type="text"]').fill("");
    await page.waitForTimeout(250);

    // ── B7: 무한스크롤 ──────────────────────────────────────────────────────
    const beforeScroll = (await rowNames(page)).length;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(600);
    const afterScroll = (await rowNames(page)).length;
    check("B7 무한스크롤로 목록이 늘어난다", afterScroll > beforeScroll, `${beforeScroll} -> ${afterScroll}`);
    await page.close();
  }

  // ── B3: 집계 실패해도 목록이 살아있다 ──────────────────────────────────────
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on("pageerror", (e) => { failures += 1; console.error(`BROWSER_PAGE_ERROR: ${e.message}`); });
    await page.route("**/api/roster", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
    await page.route("**/api/player-popularity", (r) => r.fulfill({ status: 500, body: "boom" }));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector(ROW, { timeout: 6000 }).catch(() => {});
    const names = await rowNames(page);
    const stuck = await page.locator('[data-testid="players-popularity-loading"]').count();
    check("B3a 집계 500 이어도 목록이 사라지지 않는다", names.length === 20, `rows=${names.length}`);
    check("B3c 실패 시 로딩에 영원히 갇히지 않는다", stuck === 0, `loading_visible=${stuck}`);
    check("B3b 집계 실패 시 가나다순 폴백", names[0] === EXPECTED_ALPHA1, `top=${names[0]}`);
    await page.close();
  }

  // ── B5: 제거된 구 딥링크 ───────────────────────────────────────────────────
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on("pageerror", (e) => { failures += 1; console.error(`BROWSER_PAGE_ERROR: ${e.message}`); });
    await page.route("**/api/roster", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
    await page.route("**/api/player-popularity", (r) =>
      r.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ counts: COUNTS, degraded: false }),
      }));
    await page.goto(`http://127.0.0.1:${port}/?sort=posts`);
    await page.waitForSelector(ROW, { timeout: 5000 });
    const names = await rowNames(page);
    check(
      "B5a 구 딥링크 ?sort=posts 가 빈 화면이 아니라 인기순으로 정규화",
      JSON.stringify(names.slice(0, 3)) === JSON.stringify(EXPECTED_TOP3),
      `${JSON.stringify(names.slice(0, 3))}`,
    );
    const removed = await page.locator("button", { hasText: "게시글수" }).count();
    const removed2 = await page.locator("button", { hasText: "직찍수" }).count();
    check("B5b 제거된 토글이 화면에 없다", removed === 0 && removed2 === 0, `게시글수=${removed} 직찍수=${removed2}`);
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  rmSync(GEN, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`FAIL players sort browser: ${failures} check(s) failed${MUTATE ? ` (mutation=${MUTATE})` : ""}`);
  process.exit(1);
}
console.log(`PASS players sort browser: popularity_default + no_reorder + failure_fallback + toggle + legacy_url + search + infinite_scroll${MUTATE ? ` (mutation=${MUTATE} NOT detected — 게이트 결함)` : ""}`);
