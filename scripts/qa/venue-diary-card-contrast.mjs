#!/usr/bin/env node
/**
 * 직관 다이어리 카드 light/dark 대비 harness (삼순 PR#913 리뷰 blocker).
 *
 * 실제 VenueDiaryCard 를 브라우저에 마운트(effect→요약 카드 렌더)하고, 프로젝트의
 * 실제 컴파일 Tailwind CSS 하에서 아래를 light·dark 두 테마 computed style 로 검증한다:
 *   1) 활성 연도탭 / '지난 경기 추가하기' CTA 배경 = accent(투명 아님) + CTA box-shadow
 *   2) 고정 다크 요약카드 수치(3열) 가 실제 렌더 배경 대비 ≥4.5:1
 *   3) 개인정보 안내문구 / 비활성 연도탭 텍스트가 실제 렌더 배경 대비 ≥4.5:1
 *
 * false-green 방지:
 *  - CSS 는 원본 globals.css 를 그대로 컴파일 → 없는 토큰(bg-brand-primary)은 규칙 미생성.
 *  - 대비 기준 배경은 하드코딩이 아니라 실제 요소의 computed background 를 부모까지
 *    합성(alpha over + gradient 평균)해 도출 → 카드 배경을 bg-white 로 바꾸면 FAIL.
 *  - mutation self-guard: 카드 배경을 강제 흰색으로 바꾸면 수치 대비가 <4.5 로 떨어지는지
 *    실제로 확인(harness 가 배경 변조에 민감함을 증명).
 *  - codegen(entry/stub) 은 repo 밖(os.tmpdir)에 써서 후속 tsc 를 오염시키지 않는다.
 *
 * 실행: npm run qa:diary-contrast  (node scripts/qa/venue-diary-card-contrast.mjs)
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import playwright from "playwright";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = process.cwd();
const SHOT = resolve(ROOT, "tmp/qa-screenshots");
mkdirSync(SHOT, { recursive: true });
// repo 밖 codegen 디렉터리 → tsconfig(**/*.tsx, allowJs) 가 스캔하지 않음 → harness→tsc PASS
const GEN = mkdtempSync(resolve(tmpdir(), "diary-contrast-"));

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok" : "FAIL"} - ${msg}`);
  if (!cond) failures += 1;
};

// ---- 1) stub 모듈(데이터 훅 + 닫힌 모달만) ----
writeFileSync(
  resolve(GEN, "stub-auth.jsx"),
  `import React from "react";
export function AuthProvider({ children }){ return React.createElement(React.Fragment, null, children); }
export const useAuth = () => ({ user: { id: "qa", email: "harinclaw@gmail.com" }, profile: { team_id: 1 } });
export default { AuthProvider, useAuth };
`,
);
writeFileSync(
  resolve(GEN, "stub-client.js"),
  `export const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: "x" } } }) } };
export async function getSafeSession(){ return { access_token: "x" }; }
`,
);
writeFileSync(resolve(GEN, "stub-null.jsx"), `export default function Stub(){ return null; }\n`);
writeFileSync(
  resolve(GEN, "entry.jsx"),
  `import React from "react";
import { createRoot } from "react-dom/client";
import VenueDiaryCard from "@/components/my/VenueDiaryCard";
createRoot(document.getElementById("root")).render(React.createElement(VenueDiaryCard));
`,
);

// ---- 2) 실제 컴포넌트 브라우저 번들(데이터 훅·닫힌 모달만 alias) ----
await build({
  entryPoints: [resolve(GEN, "entry.jsx")],
  bundle: true,
  format: "iife",
  outfile: resolve(GEN, "bundle.js"),
  jsx: "automatic",
  absWorkingDir: ROOT,
  nodePaths: [resolve(ROOT, "node_modules")],
  tsconfig: resolve(ROOT, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "error",
  alias: {
    "@/lib/supabase/AuthContext": resolve(GEN, "stub-auth.jsx"),
    "@/lib/supabase/client": resolve(GEN, "stub-client.js"),
    "@/components/my/VenueDiaryAddGameSheet": resolve(GEN, "stub-null.jsx"),
    "@/components/my/VenueDiaryUploader": resolve(GEN, "stub-null.jsx"),
    "@/components/my/VenueDiaryViewer": resolve(GEN, "stub-null.jsx"),
  },
});
const bundleJs = readFileSync(resolve(GEN, "bundle.js"), "utf8");

// ---- 3) 실제 프로젝트 CSS 컴파일 ----
const compiled = await postcss([tailwind]).process(
  readFileSync(resolve(ROOT, "src/styles/globals.css"), "utf8"),
  { from: resolve(ROOT, "src/styles/globals.css") },
);
console.log(`compiled CSS: ${(compiled.css.length / 1024).toFixed(0)}KB`);
check(/\.bg-accent\b/.test(compiled.css), "compiled CSS 에 .bg-accent 규칙 존재");
check(!/\.bg-brand-primary\b/.test(compiled.css), "compiled CSS 에 .bg-brand-primary 규칙 없음(구 토큰=무색)");

const attendance = {
  season: 2026,
  summary: { attendanceCount: 18, wins: 12, losses: 5, draws: 1, finalCount: 18, winRate: 1 },
  diaryGameCount: 18,
  games: [],
};
const media = { season: 2026, games: [], nextCursor: null, hasMore: false };

// ---- 로컬 서버(상대경로 fetch origin 확보) ----
import { createServer } from "node:http";
let THEME = "light";
const server = createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url.startsWith("/api/me/venue-attendance"))
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(attendance));
  if (url.startsWith("/api/me/venue-diary/media"))
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(media));
  if (url === "/app.css") return res.writeHead(200, { "content-type": "text/css" }).end(compiled.css);
  if (url === "/bundle.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(bundleJs);
  res.writeHead(200, { "content-type": "text/html" }).end(
    `<!doctype html><html class="${THEME === "dark" ? "dark" : ""}"><head><meta charset="utf8">` +
      `<link rel="stylesheet" href="/app.css"></head>` +
      `<body class="bg-bg-primary" style="margin:0;padding:12px"><div id="root"></div>` +
      `<script src="/bundle.js"></script></body></html>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

// ---- 페이지 내부에서 실제 렌더 배경을 합성해 대비를 재는 헬퍼(문자열로 주입) ----
const PAGE_HELPERS = `
  const cv = document.createElement("canvas"); cv.width = cv.height = 1;
  const g = cv.getContext("2d");
  function toRGB(color){ g.clearRect(0,0,1,1); g.fillStyle="#000"; g.fillStyle=color; g.fillRect(0,0,1,1);
    const d = g.getImageData(0,0,1,1).data; return [d[0],d[1],d[2]]; }
  function rgba(str){ // returns {rgb:[r,g,b], a}
    g.clearRect(0,0,1,1); g.fillStyle="rgba(0,0,0,0)"; g.fillStyle=str; g.fillRect(0,0,1,1);
    const d = g.getImageData(0,0,1,1).data; return { rgb:[d[0],d[1],d[2]], a: d[3]/255 }; }
  function over(fg, bg){ return fg.rgb.map((c,i)=> Math.round(c*fg.a + bg[i]*(1-fg.a))); }
  function gradientAvg(img){ const m = img.match(/rgba?\\([^)]+\\)/g); if(!m) return null;
    const cols = m.map(rgba).filter(c=>c.a>0.01); if(!cols.length) return null;
    const n = cols.length; return [0,1,2].map(i=> Math.round(cols.reduce((s,c)=>s+c.rgb[i],0)/n)); }
  // 요소의 실제 렌더 배경 = 조상 체인의 background-color(alpha)·gradient 를 흰 base 위에 합성
  function effectiveBg(el){
    const chain=[]; for(let e=el; e && e!==document.documentElement; e=e.parentElement) chain.push(e);
    chain.push(document.documentElement);
    let acc = [255,255,255];
    for(let i=chain.length-1; i>=0; i--){
      const cs = getComputedStyle(chain[i]);
      const bc = rgba(cs.backgroundColor); if(bc.a>0.001) acc = over(bc, acc);
      if(cs.backgroundImage && cs.backgroundImage!=="none"){ const gv = gradientAvg(cs.backgroundImage);
        if(gv) acc = gv; } // gradient 는 불투명 레이어로 간주
    }
    return acc;
  }
  function lum(c){ const f=c.map(v=>{ const s=v/255; return s<=0.03928? s/12.92 : Math.pow((s+0.055)/1.055,2.4); });
    return 0.2126*f[0]+0.7152*f[1]+0.0722*f[2]; }
  function contrast(fg, bg){ const L1=lum(fg), L2=lum(bg); const hi=Math.max(L1,L2), lo=Math.min(L1,L2);
    return (hi+0.05)/(lo+0.05); }
  window.__probe = (el)=>{ const cs=getComputedStyle(el); const fg=toRGB(cs.color); const bg=effectiveBg(el);
    return { fg, bg, ratio: contrast(fg,bg) }; };
`;

// CI(DIARY_CONTRAST_REQUIRE_BROWSER=1)에선 fail-closed: chromium 없으면 exit 1.
// 그 외(로컬/Vercel prebuild) 에선 chromium 미설치면 graceful skip(exit 0)로 배포 무해.
const REQUIRE_BROWSER = process.env.DIARY_CONTRAST_REQUIRE_BROWSER === "1";
let browser;
try {
  browser = await playwright.chromium.launch();
} catch (e) {
  const line = e.message.split("\n")[0];
  server.close();
  rmSync(GEN, { recursive: true, force: true });
  if (REQUIRE_BROWSER) {
    console.error(`FAIL: playwright chromium launch 실패(fail-closed) — ${line}`);
    process.exit(1);
  }
  console.log(`SKIP: playwright chromium 사용 불가 — ${line}`);
  process.exit(0);
}
try {
  for (const theme of ["light", "dark"]) {
    THEME = theme;
    const ctx = await browser.newContext({ viewport: { width: 360, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
    await page.goto(`http://127.0.0.1:${PORT}/my`, { waitUntil: "load" });
    await page.waitForFunction(() => /인증 직관/.test(document.body.innerText), null, { timeout: 8000 });
    await page.addScriptTag({ content: PAGE_HELPERS });

    const m = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll("button")].filter((b) => /^(2026|2025|전체)$/.test((b.textContent || "").trim()));
      const activeTab = tabs.find((b) => (b.textContent || "").trim() === "2026");
      const inactiveTabs = tabs.filter((b) => b !== activeTab);
      const cta = [...document.querySelectorAll("button")].find((b) => /지난 경기 추가하기/.test(b.textContent || ""));
      const info = [...document.querySelectorAll("span")].find((s) => /나만 볼 수 있고/.test(s.textContent || ""));
      const grid = document.querySelector('[class*="grid-cols-3"]');
      const nums = grid ? [...grid.children].map((c) => c.querySelector("p")).filter(Boolean) : [];
      const card = document.querySelector('[class*="from-["]');
      const cs = (el) => getComputedStyle(el);
      const win = window;
      return {
        activeTabBg: win.__probe(activeTab) && (() => { const c = cs(activeTab); return c.backgroundColor; })(),
        activeTabBgRGB: (() => { const c = cs(activeTab); const p = document.createElement("canvas").getContext("2d"); p.fillStyle = c.backgroundColor; return p.fillStyle; })(),
        ctaBg: cs(cta).backgroundColor,
        ctaShadow: cs(cta).boxShadow,
        nums: nums.map((p) => ({ t: p.textContent.trim(), ...win.__probe(p) })),
        info: win.__probe(info),
        inactive: inactiveTabs.map((b) => ({ t: b.textContent.trim(), ...win.__probe(b) })),
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });

    // 원본(unmutated) 스크린샷 — mutation 전에 캡처
    await page.screenshot({ path: resolve(SHOT, `diary-card-${theme}-360.png`) });

    // mutation self-guard: 카드 배경 강제 흰색 → 수치 대비 붕괴 확인 후 즉시 복구(격리)
    const mutated = await page.evaluate(() => {
      const card = document.querySelector('[class*="from-["]');
      const grid = document.querySelector('[class*="grid-cols-3"]');
      const p = grid.children[0].querySelector("p");
      const prevImg = card.style.backgroundImage;
      const prevColor = card.style.backgroundColor;
      card.style.backgroundImage = "none";
      card.style.backgroundColor = "#ffffff";
      const ratio = window.__probe(p).ratio;
      card.style.backgroundImage = prevImg;
      card.style.backgroundColor = prevColor;
      return ratio;
    });
    m.mutated = mutated;

    const accentBg = await page.evaluate(() => {
      const p = document.createElement("canvas").getContext("2d");
      p.fillStyle = getComputedStyle([...document.querySelectorAll("button")].find((b) => /지난 경기 추가하기/.test(b.textContent || ""))).backgroundColor;
      return p.fillStyle;
    });

    console.log(`\n[${theme}] cta=${m.ctaBg} nums=${m.nums.map((n) => n.t + ":" + n.ratio.toFixed(1)).join(",")} info=${m.info.ratio.toFixed(2)} inactive=${m.inactive.map((n) => n.ratio.toFixed(2)).join(",")} mutated=${m.mutated.toFixed(2)}`);

    const isAccent = (s) => /rgb\(255,\s*69,\s*58\)|#ff453a/i.test(s);
    check(isAccent(m.ctaBg), `[${theme}] CTA 배경 = accent (${m.ctaBg})`);
    check(isAccent(m.activeTabBg), `[${theme}] 활성 연도탭 배경 = accent (${m.activeTabBg})`);
    check(m.ctaShadow && m.ctaShadow !== "none", `[${theme}] CTA box-shadow 존재`);
    check(m.nums.length === 3, `[${theme}] 요약 3열 수치 3개 (${m.nums.map((n) => n.t).join(",")})`);
    for (const n of m.nums) check(n.ratio >= 4.5, `[${theme}] 수치 '${n.t}' 대비 ${n.ratio.toFixed(2)}:1 ≥4.5`);
    check(m.info.ratio >= 4.5, `[${theme}] 개인정보 안내문구 대비 ${m.info.ratio.toFixed(2)}:1 ≥4.5`);
    for (const t of m.inactive) check(t.ratio >= 4.5, `[${theme}] 비활성 연도탭 '${t.t}' 대비 ${t.ratio.toFixed(2)}:1 ≥4.5`);
    check(m.docOverflow <= 0, `[${theme}] 가로 overflow 0 (delta=${m.docOverflow})`);
    // 배경 변조에 민감함을 증명(흰 배경 위 흰 수치는 대비 붕괴)
    check(m.mutated < 4.5, `[${theme}] mutation guard — 카드 bg=흰색 변조 시 수치 대비 ${m.mutated.toFixed(2)}<4.5 (harness가 배경 변조 감지, 캡처 후 복구)`);

    void accentBg;
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
