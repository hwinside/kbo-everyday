#!/usr/bin/env node
/**
 * 직관 다이어리 카드 light/dark 대비 harness (삼순 PR#913 NO-GO 왕복3 blocker).
 *
 * 목적: 실제 VenueDiaryCard 컴포넌트를 브라우저에 마운트(effect 실행 → 요약 카드 렌더)하고,
 * 프로젝트의 실제 Tailwind CSS(globals.css) 하에서
 *   1) 활성 연도 탭 배경 = accent(투명 아님)
 *   2) '지난 경기 추가하기' CTA 배경 = accent + box-shadow 존재
 *   3) 고정 다크 요약카드의 수치(18 / 100.0% / 18경기)가 카드 배경 대비 ≥4.5:1
 * 를 light·dark 두 테마 실제 computed style 로 assertion 한다.
 *
 * false-green 방지: CSS 는 프로젝트 원본을 그대로 컴파일(@tailwindcss/postcss)하므로
 * 존재하지 않는 토큰(bg-brand-primary)은 규칙이 생성되지 않아 투명→대비/배경 assertion 실패.
 * 마크업은 하드코딩이 아니라 실제 컴포넌트를 mount 해 얻는다(데이터 훅/닫힌 모달만 stub).
 *
 * 실행: node scripts/qa/venue-diary-card-contrast.mjs
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import playwright from "playwright";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const OUT = resolve(ROOT, "tmp/diary-contrast");
mkdirSync(OUT, { recursive: true });
const SHOT = resolve(ROOT, "tmp/qa-screenshots");
mkdirSync(SHOT, { recursive: true });

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok" : "FAIL"} - ${msg}`);
  if (!cond) failures += 1;
};

// ---- 1) stub 모듈(데이터 훅 + 닫힌 모달만) ----
const stubs = {
  auth: resolve(OUT, "stub-auth.tsx"),
  client: resolve(OUT, "stub-client.ts"),
  nullmod: resolve(OUT, "stub-null.tsx"),
};
writeFileSync(
  stubs.auth,
  `import React from "react";
export function AuthProvider({ children }){ return <>{children}</>; }
export const useAuth = () => ({
  user: { id: "qa-admin", email: "harinclaw@gmail.com" },
  profile: { team_id: 1 },
});
export default { AuthProvider, useAuth };
`,
);
writeFileSync(
  stubs.client,
  `export const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: "qa" } } }) } };
export async function getSafeSession(){ return { access_token: "qa" }; }
`,
);
writeFileSync(
  stubs.nullmod,
  `export default function Stub(){ return null; }
`,
);

const entry = resolve(OUT, "entry.tsx");
writeFileSync(
  entry,
  `import React from "react";
import { createRoot } from "react-dom/client";
import VenueDiaryCard from "@/components/my/VenueDiaryCard";
createRoot(document.getElementById("root")).render(<VenueDiaryCard />);
`,
);

// ---- 2) 실제 컴포넌트 브라우저 번들(닫힌 모달·데이터 훅만 alias) ----
await build({
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  outfile: resolve(OUT, "bundle.js"),
  jsx: "automatic",
  loader: { ".ts": "tsx", ".tsx": "tsx" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "error",
  alias: {
    "@/lib/supabase/AuthContext": stubs.auth,
    "@/lib/supabase/client": stubs.client,
    "@/components/my/VenueDiaryAddGameSheet": stubs.nullmod,
    "@/components/my/VenueDiaryUploader": stubs.nullmod,
    "@/components/my/VenueDiaryViewer": stubs.nullmod,
  },
  tsconfig: resolve(ROOT, "tsconfig.json"),
});
const bundleJs = readFileSync(resolve(OUT, "bundle.js"), "utf8");

// ---- 3) 실제 프로젝트 CSS 컴파일 ----
const cssSrc = readFileSync(resolve(ROOT, "src/styles/globals.css"), "utf8");
const compiled = await postcss([tailwind]).process(cssSrc, {
  from: resolve(ROOT, "src/styles/globals.css"),
});
writeFileSync(resolve(OUT, "app.css"), compiled.css);
console.log(`compiled CSS: ${(compiled.css.length / 1024).toFixed(0)}KB`);

// bg-accent 규칙 존재 + bg-brand-primary(구 토큰) 미생성 확인 → 회귀 가드의 근거
check(/\.bg-accent\b/.test(compiled.css), "compiled CSS 에 .bg-accent 규칙 존재");
check(!/\.bg-brand-primary\b/.test(compiled.css), "compiled CSS 에 .bg-brand-primary 규칙 없음(구 토큰=무색)");

// ---- 4) 요약 fixture (18 / 100.0% / 18경기) ----
const attendance = {
  season: 2026,
  summary: { attendanceCount: 18, wins: 12, losses: 5, draws: 1, finalCount: 18, winRate: 1 },
  diaryGameCount: 18,
  games: [],
};
const media = { season: 2026, games: [], nextCursor: null, hasMore: false };

function contrast(fg, bg) {
  const lum = (c) => {
    const [r, g, b] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const L1 = lum(fg), L2 = lum(bg);
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}
const parseRGB = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);

// 상대경로 fetch 가 실제 origin 을 갖도록 로컬 서버로 서빙(effect 데이터 로드 성립).
let THEME = "light";
const server = createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url.startsWith("/api/me/venue-attendance")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(attendance));
  }
  if (url.startsWith("/api/me/venue-diary/media")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(media));
  }
  if (url === "/app.css") {
    res.writeHead(200, { "content-type": "text/css" });
    return res.end(compiled.css);
  }
  if (url === "/bundle.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(bundleJs);
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<!doctype html><html class="${THEME === "dark" ? "dark" : ""}"><head><meta charset="utf8">` +
      `<link rel="stylesheet" href="/app.css"></head>` +
      `<body class="bg-bg-primary" style="margin:0;padding:12px"><div id="root"></div>` +
      `<script src="/bundle.js"></script></body></html>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

const browser = await playwright.chromium.launch();
for (const theme of ["light", "dark"]) {
  THEME = theme;
  const ctx = await browser.newContext({ viewport: { width: 360, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  page.on("console", (msg) => { if (msg.type() === "error") console.log(`  [console.error] ${msg.text()}`); });
  await page.goto(`http://127.0.0.1:${PORT}/my`, { waitUntil: "load" });
  // effect 로 요약 카드 렌더될 때까지
  try {
    await page.waitForFunction(() => /인증 직관/.test(document.body.innerText), null, { timeout: 8000 });
  } catch {
    console.log(`  [${theme}] body.innerText head:`, (await page.evaluate(() => document.body.innerText)).slice(0, 200));
  }

  const m = await page.evaluate(() => {
    const q = (re) =>
      [...document.querySelectorAll("button,p,span,div")].find((el) => re.test(el.textContent || ""));
    const activeTab = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "2026");
    const cta = [...document.querySelectorAll("button")].find((b) => /지난 경기 추가하기/.test(b.textContent || ""));
    const card = document.querySelector('[class*="from-["]') || cta?.closest("div");
    // 요약 3열 수치 <p> — 3-col 그리드의 각 컬럼 첫 <p>(값) 구조로 선택(값 변동 무관)
    const grid = document.querySelector('[class*="grid-cols-3"]');
    const nums = grid
      ? [...grid.children].map((col) => col.querySelector("p")).filter(Boolean)
      : [];
    const cs = (el) => (el ? getComputedStyle(el) : null);
    // oklch/oklab 등 임의 CSS 색을 canvas 로 실제 rgb 픽셀로 해석(파서 통일).
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const g = cv.getContext("2d");
    const toRGB = (color) => {
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = "#000";
      g.fillStyle = color;
      g.fillRect(0, 0, 1, 1);
      const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
      return [r, gg, b];
    };
    const cardCs = cs(card);
    return {
      activeTabBg: toRGB(cs(activeTab).backgroundColor),
      ctaBg: toRGB(cs(cta).backgroundColor),
      ctaShadow: cs(cta)?.boxShadow,
      cardBgImage: cardCs?.backgroundImage,
      nums: nums.map((p) => ({ t: p.textContent.trim(), rgb: toRGB(cs(p).color) })),
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  console.log(`\n[${theme}]`, JSON.stringify(m, null, 0));
  // 카드 배경: 그라디언트라 backgroundColor 가 투명일 수 있어 고정 다크 그라디언트 끝색(#141417≈20,20,23)을 대비 기준으로 사용
  const cardRef = [20, 20, 23];
  const accent = [255, 69, 58];

  check(JSON.stringify(m.activeTabBg) === JSON.stringify(accent), `[${theme}] 활성 연도탭 배경 = accent rgb(${m.activeTabBg})`);
  check(JSON.stringify(m.ctaBg) === JSON.stringify(accent), `[${theme}] CTA 배경 = accent rgb(${m.ctaBg})`);
  check(!!m.ctaShadow && m.ctaShadow !== "none", `[${theme}] CTA box-shadow 존재 ${m.ctaShadow?.slice(0, 40)}`);
  check(m.nums.length === 3, `[${theme}] 요약 3열 수치 3개 검출 (${m.nums.map((n) => n.t).join(",")})`);
  for (const n of m.nums) {
    const ratio = contrast(n.rgb, cardRef);
    check(ratio >= 4.5, `[${theme}] 수치 '${n.t}' 대비 ${ratio.toFixed(2)}:1 ≥4.5 (rgb ${n.rgb})`);
  }
  check(m.docOverflow <= 0, `[${theme}] 가로 overflow 0 (delta=${m.docOverflow})`);

  await page.screenshot({ path: resolve(SHOT, `diary-card-${theme}-360.png`) });
  await ctx.close();
}
await browser.close();
server.close();

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
