#!/usr/bin/env node
/**
 * 직관 다이어리 '경기별 기록' 기본 접힘 회귀 — 실제 VenueDiaryCard 를 390×844 Chromium 에 마운트.
 *
 * 2026-08-03 하린아빠 리포트: 마이페이지에서 경기별 기록 리스트가 세로 공간을 너무 많이 차지한다.
 * → 기본 접힘, 유저가 펼칠 때만 렌더.
 *
 * false-green 방지:
 *  - stub 이 아니라 실제 컴포넌트를 번들해 실제 컴파일 Tailwind CSS 로 렌더한다.
 *  - "접혀 있다"를 클래스 문자열이 아니라 실제 DOM(경기 카드 노드 수)과 실측 높이로 잰다.
 *  - 접힘/펼침 카드 높이를 둘 다 재서 실제로 세로 공간이 줄어드는지 확인한다(하린아빠 요구의 본질).
 *  - mutation: 기본값을 열림으로 바꾸거나 fold 가드를 제거하면 RED 가 되는지 실제로 증명한다.
 *
 * 실행: npm run qa:venue-diary-games-fold
 *   mutation: VENUE_DIARY_FOLD_MUTATE=default-open|always-render node scripts/qa/venue-diary-games-fold.mjs
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import playwright from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = process.cwd();
const REQUIRE_BROWSER = process.env.VENUE_DIARY_FOLD_REQUIRE_BROWSER === "1";
const MUTATE = process.env.VENUE_DIARY_FOLD_MUTATE ?? "";

let chromiumPath = null;
try {
  chromiumPath = playwright.chromium.executablePath();
} catch {
  chromiumPath = null;
}
if (!chromiumPath || !existsSync(chromiumPath)) {
  const detail = chromiumPath ? `not found at ${chromiumPath}` : "executablePath unavailable";
  if (REQUIRE_BROWSER) {
    console.error(`FAIL: playwright chromium 사용 불가(fail-closed) — ${detail}`);
    process.exit(1);
  }
  console.log(`SKIP: playwright chromium 사용 불가 — ${detail}`);
  process.exit(0);
}

const GEN = mkdtempSync(resolve(tmpdir(), "diary-fold-"));
const SHOT = resolve(ROOT, "tmp/qa-screenshots");
mkdirSync(SHOT, { recursive: true });

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok" : "FAIL"} - ${msg}`);
  if (!cond) failures += 1;
};

// ── 대상 컴포넌트(실제 소스) + 선택적 결함 주입 ────────────────────────────────
const CARD_PATH = resolve(ROOT, "src/components/my/VenueDiaryCard.tsx");
let cardSrc = readFileSync(CARD_PATH, "utf8");

// 검증 대상 계약이 소스에 실제로 존재하는지 먼저 확인(패턴이 사라지면 mutation 이 무력화되므로 fail-close).
const DEFAULT_OPEN_PATTERN = "const [gamesOpen, setGamesOpen] = useState(false);";
const FOLD_GUARD_PATTERN = "{!gamesOpen ? null : homeGames.length === 0 ? (";
check(cardSrc.includes(DEFAULT_OPEN_PATTERN), `소스에 기본 접힘 상태 선언 존재 (${DEFAULT_OPEN_PATTERN})`);
check(cardSrc.includes(FOLD_GUARD_PATTERN), "소스에 fold 렌더 가드 존재");

if (MUTATE === "default-open") {
  cardSrc = cardSrc.replace(DEFAULT_OPEN_PATTERN, "const [gamesOpen, setGamesOpen] = useState(true);");
  console.log("  [mutation] gamesOpen 기본값 true 로 변조");
} else if (MUTATE === "always-render") {
  cardSrc = cardSrc.replace(FOLD_GUARD_PATTERN, "{homeGames.length === 0 ? (");
  console.log("  [mutation] fold 가드 제거(항상 렌더)로 변조");
} else if (MUTATE) {
  console.error(`FAIL: 알 수 없는 mutation '${MUTATE}'`);
  process.exit(1);
}
const CARD_TARGET = resolve(GEN, "VenueDiaryCard.target.tsx");
writeFileSync(CARD_TARGET, cardSrc);

// ── stub(데이터 훅 · 닫힌 모달만) ──────────────────────────────────────────────
writeFileSync(
  resolve(GEN, "stub-auth.jsx"),
  `import React from "react";
export function AuthProvider({ children }){ return React.createElement(React.Fragment, null, children); }
export const useAuth = () => ({ user: { id: "qa-fold", email: "qa-fold@example.invalid" }, profile: { team_id: 1 } });
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
    "@/components/my/VenueDiaryCard": CARD_TARGET,
    "@/lib/supabase/AuthContext": resolve(GEN, "stub-auth.jsx"),
    "@/lib/supabase/client": resolve(GEN, "stub-client.js"),
    "@/components/my/VenueDiaryAddGameSheet": resolve(GEN, "stub-null.jsx"),
    "@/components/my/VenueDiaryUploader": resolve(GEN, "stub-null.jsx"),
    "@/components/my/VenueDiaryViewer": resolve(GEN, "stub-null.jsx"),
  },
});
const bundleJs = readFileSync(resolve(GEN, "bundle.js"), "utf8");

const compiled = await postcss([tailwind]).process(
  readFileSync(resolve(ROOT, "src/styles/globals.css"), "utf8"),
  { from: resolve(ROOT, "src/styles/globals.css") },
);

// ── fixture: 하린아빠 스크린샷과 같은 4경기(각 썸네일 1장) ────────────────────
const GAMES = [
  { gameId: "20260729OBLG0", gameDate: "2026-07-29", stadiumName: "잠실", away: "키움", home: "LG", as: 18, hs: 11, result: "L" },
  { gameId: "20260725HHLG0", gameDate: "2026-07-25", stadiumName: "대전", away: "LG", home: "한화", as: 15, hs: 11, result: "W" },
  { gameId: "20260708SSLG0", gameDate: "2026-07-08", stadiumName: "대구", away: "LG", home: "삼성", as: 8, hs: 2, result: "W" },
  { gameId: "20260704LGHH0", gameDate: "2026-07-04", stadiumName: "잠실", away: "한화", home: "LG", as: 3, hs: 5, result: "W" },
];
const TEAM_ID = { 키움: 6, LG: 1, 한화: 4, 삼성: 3 };
// 1×1 투명 PNG(외부 네트워크 의존 없이 썸네일 렌더).
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const attendance = {
  season: 2026,
  summary: { attendanceCount: 4, wins: 3, losses: 1, draws: 0, finalCount: 4, winRate: 0.75 },
  overallSummary: { attendanceCount: 4, wins: 3, losses: 1, draws: 0, finalCount: 4, winRate: 0.75 },
  diaryGameCount: GAMES.length,
  games: GAMES.map((g) => ({
    gameId: g.gameId,
    result: g.result,
    awayTeam: { id: TEAM_ID[g.away], name: g.away, score: g.as },
    homeTeam: { id: TEAM_ID[g.home], name: g.home, score: g.hs },
  })),
};
const media = {
  season: 2026,
  games: GAMES.map((g) => ({
    gameId: g.gameId,
    gameDate: g.gameDate,
    stadiumName: g.stadiumName,
    counts: { image: 1, video: 0, total: 1 },
    thumbnails: [{ id: 1, mediaType: "image", thumbUrl: PIXEL, venueVerified: false }],
  })),
  nextCursor: null,
  hasMore: false,
};

const server = createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url.startsWith("/api/me/venue-attendance"))
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(attendance));
  if (url.startsWith("/api/me/venue-diary/media"))
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(media));
  if (url === "/app.css") return res.writeHead(200, { "content-type": "text/css" }).end(compiled.css);
  if (url === "/bundle.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(bundleJs);
  res.writeHead(200, { "content-type": "text/html" }).end(
    `<!doctype html><html class="dark"><head><meta charset="utf8">` +
      `<link rel="stylesheet" href="/app.css"></head>` +
      `<body class="bg-bg-primary" style="margin:0;padding:0"><div id="root"></div>` +
      `<script src="/bundle.js"></script></body></html>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

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
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto(`http://127.0.0.1:${PORT}/my`, { waitUntil: "load" });
  await page.waitForFunction(() => /인증 직관/.test(document.body.innerText), null, { timeout: 8000 });

  // 경기 카드 = viewer 를 여는 버튼. 토글/CTA/연도탭과 구분하기 위해 gameId 대신
  // "경기 카드에만 있는" 날짜·구장 텍스트 패턴으로 실제 렌더 노드를 센다.
  const readState = () =>
    page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const toggle = btns.find((b) => /^경기별 기록/.test((b.textContent || "").trim()));
      const rows = btns.filter((b) => /^\d{4}\.\d{2}\.\d{2}\s·\s/.test((b.textContent || "").trim()));
      const root = document.getElementById("root");
      return {
        hasToggle: toggle != null,
        toggleText: toggle ? (toggle.textContent || "").trim().replace(/\s+/g, " ") : null,
        ariaExpanded: toggle ? toggle.getAttribute("aria-expanded") : null,
        toggleH: toggle ? Math.round(toggle.getBoundingClientRect().height) : 0,
        rowCount: rows.length,
        thumbs: document.querySelectorAll('img[src^="data:image/png"]').length,
        rootH: Math.round(root.getBoundingClientRect().height),
        docH: Math.round(document.documentElement.scrollHeight),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });

  const collapsed = await readState();
  console.log(
    `\n[collapsed] toggle="${collapsed.toggleText}" aria=${collapsed.ariaExpanded} rows=${collapsed.rowCount} thumbs=${collapsed.thumbs} rootH=${collapsed.rootH}`,
  );
  await page.screenshot({ path: resolve(SHOT, "diary-games-fold-collapsed.png") });

  check(collapsed.hasToggle, "'경기별 기록' 토글 버튼 렌더됨");
  check(collapsed.ariaExpanded === "false", `기본 aria-expanded=false (got ${collapsed.ariaExpanded})`);
  check(collapsed.rowCount === 0, `기본 접힘 — 경기 카드 0개 (got ${collapsed.rowCount})`);
  check(collapsed.thumbs === 0, `기본 접힘 — 썸네일 0장 (got ${collapsed.thumbs})`);
  check(
    collapsed.toggleText != null && collapsed.toggleText.includes(String(GAMES.length)),
    `접힌 상태에서도 경기 수 ${GAMES.length} 노출 (got "${collapsed.toggleText}")`,
  );
  check(collapsed.toggleH >= 44, `토글 터치 타깃 높이 ${collapsed.toggleH}px ≥44`);
  check(collapsed.overflowX <= 0, `가로 overflow 0 (delta=${collapsed.overflowX})`);

  await page.getByRole("button", { name: /경기별 기록/ }).click();
  const expanded = await readState();
  console.log(
    `[expanded]  aria=${expanded.ariaExpanded} rows=${expanded.rowCount} thumbs=${expanded.thumbs} rootH=${expanded.rootH}`,
  );
  await page.screenshot({ path: resolve(SHOT, "diary-games-fold-expanded.png") });

  check(expanded.ariaExpanded === "true", `펼친 뒤 aria-expanded=true (got ${expanded.ariaExpanded})`);
  check(
    expanded.rowCount === GAMES.length,
    `펼친 뒤 경기 카드 ${GAMES.length}개 렌더 (got ${expanded.rowCount})`,
  );
  check(expanded.thumbs === GAMES.length, `펼친 뒤 썸네일 ${GAMES.length}장 (got ${expanded.thumbs})`);
  check(expanded.overflowX <= 0, `펼친 뒤 가로 overflow 0 (delta=${expanded.overflowX})`);

  // 하린아빠 요구의 본질 = 세로 공간 절감. 실측 높이로 잠근다.
  const saved = expanded.rootH - collapsed.rootH;
  check(
    saved >= 200,
    `접힘이 세로 ${saved}px 절약 (기대 ≥200 — 접힘 ${collapsed.rootH} vs 펼침 ${expanded.rootH})`,
  );

  await page.getByRole("button", { name: /경기별 기록/ }).click();
  const recollapsed = await readState();
  check(recollapsed.rowCount === 0, `재클릭 시 다시 접힘 — 경기 카드 0개 (got ${recollapsed.rowCount})`);
  check(
    recollapsed.ariaExpanded === "false",
    `재클릭 시 aria-expanded=false (got ${recollapsed.ariaExpanded})`,
  );
  check(
    recollapsed.rootH === collapsed.rootH,
    `재클릭 높이 원복 (${recollapsed.rootH} vs ${collapsed.rootH})`,
  );

  await ctx.close();
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failure(s)${MUTATE ? ` [mutation=${MUTATE}]` : ""}`);
process.exit(failures === 0 ? 0 : 1);
