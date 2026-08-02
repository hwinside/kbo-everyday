#!/usr/bin/env node
/**
 * 승패·긍정/부정 컬러톤 SSOT 게이트 (삼순 #1068 리뷰 Blocker 2).
 *
 * 왜 필요한가 — 기존 게이트가 false-green 이었다:
 *   삼순이 RESULT_TONE_COLOR 의 positive/negative 를 서로 바꿨는데
 *   `qa:diary-contrast`·`qa:venue-stats-s2-browser` 가 둘 다 PASS 했다.
 *   전자는 fixture 가 games=[] 라 결과 칩을 아예 렌더하지 않았고,
 *   후자는 대비(contrast)만 보므로 승/패 색이 뒤집혀도 대비는 그대로다.
 *   즉 "의미색이 올바른 쪽에 붙었는가" 를 보는 게이트가 하나도 없었다.
 *
 * 이 게이트가 보는 것(전부 실제 컴포넌트의 실제 DOM computed style):
 *   1) 팔레트 exact — base/soft/bg 값이 홈 팀카드 실측 계약과 문자 단위로 일치
 *   2) 의미 매핑 — W→positive · L→negative · D→neutral (뒤집히면 FAIL)
 *   3) 실배선 — 기준 화면(홈 TeamCard)과 변경 소비자 5종이 같은 값을 실제로 렌더
 *
 * mutation RED(이 게이트가 진짜 잡는지 증명):
 *   RESULT_TONE_MUTATE_SWAP=1        승/패 색 역전        → FAIL 이어야 한다
 *   RESULT_TONE_MUTATE_UNWIRE=<name> 소비자 하드코딩 복귀 → FAIL 이어야 한다
 *     name ∈ teamcard | diary | playerlogs | schedule | roster
 *
 * CI(RESULT_TONE_REQUIRE_BROWSER=1)에선 chromium 부재도 fail-closed(exit 1).
 *
 * 실행: npm run qa:result-tone
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import playwright from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = process.cwd();
const REQUIRE_BROWSER = process.env.RESULT_TONE_REQUIRE_BROWSER === "1";
const SWAP = process.env.RESULT_TONE_MUTATE_SWAP === "1";
const UNWIRE = process.env.RESULT_TONE_MUTATE_UNWIRE ?? "";

let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok" : "FAIL"} - ${msg}`);
  if (cond) pass += 1;
  else fail += 1;
};

// ── 계약 상수 ────────────────────────────────────────────────────────────────
// 모듈에서 import 하지 않고 여기 적는다. import 하면 값이 바뀌어도 기대값이 같이
// 따라 움직여 어떤 변경도 통과하는 tautology 가 된다(값 회귀를 못 잡음).
const EXPECT_BASE = { positive: "#36D399", negative: "#FF6B6B", neutral: "#B0B0BA" };
const EXPECT_SOFT = { positive: "#6EE7B7", negative: "#FF9AA5", neutral: "#C9C9D4" };
const EXPECT_BG = {
  positive: "rgba(38,168,109,0.22)",
  negative: "rgba(196,1,47,0.20)",
  neutral: "rgba(160,160,170,0.18)",
};

const hexToRgb = (hex) => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const rgbaSpecToParts = (spec) => {
  const m = spec.match(/rgba?\(([^)]+)\)/);
  return m[1].split(",").map((v) => Number(v.trim()));
};
/** computed style 문자열 → [r,g,b,a] */
const parseComputed = (value) => {
  const m = String(value).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
};
const sameRgb = (computed, hex) => {
  const got = parseComputed(computed);
  if (!got) return false;
  const want = hexToRgb(hex);
  return got[0] === want[0] && got[1] === want[1] && got[2] === want[2];
};
const sameRgba = (computed, spec) => {
  const got = parseComputed(computed);
  if (!got) return false;
  const want = rgbaSpecToParts(spec);
  return (
    got[0] === want[0] &&
    got[1] === want[1] &&
    got[2] === want[2] &&
    Math.abs(got[3] - want[3]) < 0.005
  );
};

// ── chromium 가용성(fail-closed 분기) ────────────────────────────────────────
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

const GEN = mkdtempSync(resolve(tmpdir(), "result-tone-"));

// ── mutation 1: SSOT 값 자체를 역전 ─────────────────────────────────────────
const tonePath = resolve(ROOT, "src/lib/ui/result-tone.ts");
const toneSource = readFileSync(tonePath, "utf8");
let toneEntry = tonePath;
if (SWAP) {
  // positive/negative 값만 서로 바꾼다(구조·타입 무변경) → 의미색 역전 재현.
  const swapBlock = (src, constName, a, b) => {
    const re = new RegExp(`(${constName}[^=]*=\\s*\\{)([\\s\\S]*?)(\\n\\};)`);
    const m = src.match(re);
    if (!m) throw new Error(`swap mutation target not found: ${constName}`);
    const body = m[2].replace(a, "__TMP__").replace(b, a).replace("__TMP__", b);
    return src.replace(re, `$1${body}$3`);
  };
  let mutated = swapBlock(toneSource, "RESULT_TONE_COLOR", EXPECT_BASE.positive, EXPECT_BASE.negative);
  mutated = swapBlock(mutated, "RESULT_TONE_COLOR_SOFT", EXPECT_SOFT.positive, EXPECT_SOFT.negative);
  mutated = swapBlock(mutated, "RESULT_TONE_BG", EXPECT_BG.positive, EXPECT_BG.negative);
  if (mutated === toneSource) throw new Error("swap mutation produced no change");
  toneEntry = resolve(GEN, "result-tone-mutated.ts");
  writeFileSync(toneEntry, mutated);
}

// ── mutation 2: 소비자를 하드코딩 시절로 되돌림(배선 제거) ──────────────────
// 각 항목은 [파일, 찾을 문자열, 되돌릴 문자열]. 찾을 문자열이 유일하지 않으면 예외.
const UNWIRE_TARGETS = {
  teamcard: [
    "src/components/home/TeamCard.tsx",
    "style={resultToneChipStyle(gameResultTone(r))}",
    'style={r === "W" ? { background: "rgba(38,168,109,.22)", color: "#36d399" } : r === "L" ? { background: "rgba(0,0,0,.5)", color: "#3b82f6" } : { background: "rgba(160,160,170,.18)", color: "#b0b0ba" }}',
  ],
  diary: [
    "src/components/my/VenueDiaryCard.tsx",
    "style={resultToneChipStyle(gameResultTone(game.result))}",
    'style={game.result === "W" ? { background: "rgba(59,130,246,.15)", color: "#60a5fa" } : game.result === "L" ? { background: "rgba(196,1,47,.2)", color: "#f87171" } : { background: "rgba(107,114,128,.15)", color: "#9ca3af" }}',
  ],
  playerlogs: [
    "src/components/player/PlayerGameLogs.tsx",
    "      style={resultToneChipStyle(gameResultTone(result))}\n",
    '      style={result === "W" ? { background: "rgba(34,197,94,.2)", color: "#4ade80" } : result === "L" ? { background: "rgba(239,68,68,.2)", color: "#f87171" } : { background: "rgba(120,120,130,.2)", color: "#9ca3af" }}\n',
  ],
  schedule: [
    "src/app/(main)/teams/[teamId]/schedule/page.tsx",
    "? resultToneTextStyle(gameResultTone(game.result))",
    '? { color: game.result === "W" ? "#4ade80" : game.result === "L" ? "#f87171" : "#9ca3af" }',
  ],
  roster: [
    "src/components/team/TeamRosterMovesCard.tsx",
    'const labelColor = RESULT_TONE_COLOR[isRegister ? "positive" : "negative"];',
    'const labelColor = isRegister ? "#34D399" : "#F87171";',
  ],
};
const consumerAlias = {};
if (UNWIRE) {
  const target = UNWIRE_TARGETS[UNWIRE];
  if (!target) throw new Error(`unknown RESULT_TONE_MUTATE_UNWIRE: ${UNWIRE}`);
  const [rel, from, to] = target;
  const abs = resolve(ROOT, rel);
  const src = readFileSync(abs, "utf8");
  const count = src.split(from).length - 1;
  if (count !== 1) throw new Error(`unwire target must be unique in ${rel}, got ${count}`);
  const out = resolve(GEN, `unwire-${UNWIRE}.tsx`);
  writeFileSync(out, src.replace(from, to));
  consumerAlias[rel] = out;
}
const aliasFor = (rel, fallback) => consumerAlias[rel] ?? fallback ?? resolve(ROOT, rel);

// ── stub 모듈 ────────────────────────────────────────────────────────────────
writeFileSync(resolve(GEN, "auth.jsx"), `
export const useAuth=()=>({user:{id:"qa",email:"result-tone-qa@example.invalid"},profile:{team_id:1,nickname:"QA",favorite_players:[]},loading:false,refreshProfile:async()=>{},signOut:async()=>{}});`);
writeFileSync(resolve(GEN, "client.js"), `
export async function getSafeSession(){return {access_token:"qa"};}
export const supabase={auth:{getSession:async()=>({data:{session:{access_token:"qa"}}})}};`);
writeFileSync(resolve(GEN, "link.jsx"), `
export default function Link({href,children,...p}){return <a href={href} {...p}>{children}</a>;}`);
writeFileSync(resolve(GEN, "image.jsx"), `
export default function Image(p){return <img alt="" {...p}/>;}`);
writeFileSync(resolve(GEN, "navigation.js"), `
export const useRouter=()=>({push:()=>{},back:()=>{}});
export const useParams=()=>({teamId:"lg"});
export const useSearchParams=()=>new URLSearchParams();
export const usePathname=()=>window.location.pathname;`);
writeFileSync(resolve(GEN, "motion.jsx"), `
export const motion=new Proxy({},{get:(_,tag)=>({children,initial,animate,exit,transition,whileTap,layout,...p})=>{
  const T=String(tag);return <T {...p}>{children}</T>;}});
export const AnimatePresence=({children})=><>{children}</>;`);
writeFileSync(resolve(GEN, "null.jsx"), `export default function Null(){return null;}`);

// ── entry: 경로별로 실제 컴포넌트 마운트 ────────────────────────────────────
writeFileSync(resolve(GEN, "entry.jsx"), `
import React from "react";
import {createRoot} from "react-dom/client";
import TeamCard from "@/components/home/TeamCard";
import VenueDiaryCard from "@/components/my/VenueDiaryCard";
import PlayerGameLogs from "@/components/player/PlayerGameLogs";
import TeamRosterMovesCard from "@/components/team/TeamRosterMovesCard";
import SchedulePage from "@/app/(main)/teams/[teamId]/schedule/page";
import {getTeamById} from "@/lib/constants/teams";
const LG=getTeamById(1);
const path=window.location.pathname;
const App=
  path==="/teamcard" ? () => <TeamCard team={LG}/> :
  path==="/diary" ? VenueDiaryCard :
  path==="/playerlogs" ? () => <PlayerGameLogs playerId="53123" position="내야수" teamColor="#C30452"/> :
  path==="/roster" ? () => <TeamRosterMovesCard team={LG}/> :
  SchedulePage;
createRoot(document.getElementById("root")).render(<App/>);`);

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
  // 일부 컴포넌트가 런타임에 `process.env.X` 를 직접 읽어 브라우저에서 ReferenceError 가 난다.
  // 번들이 죽으면 화면이 통째로 비어 "색이 맞다/틀리다" 판정 자체가 무의미해지므로 shim 을 둔다.
  banner: { js: 'globalThis.process=globalThis.process||{env:{NODE_ENV:"production"}};' },
  logLevel: "error",
  alias: {
    "@/lib/ui/result-tone": toneEntry,
    "@/components/home/TeamCard": aliasFor("src/components/home/TeamCard.tsx"),
    "@/components/my/VenueDiaryCard": aliasFor("src/components/my/VenueDiaryCard.tsx"),
    "@/components/player/PlayerGameLogs": aliasFor("src/components/player/PlayerGameLogs.tsx"),
    "@/components/team/TeamRosterMovesCard": aliasFor("src/components/team/TeamRosterMovesCard.tsx"),
    "@/app/(main)/teams/[teamId]/schedule/page": aliasFor("src/app/(main)/teams/[teamId]/schedule/page.tsx"),
    "@/lib/supabase/AuthContext": resolve(GEN, "auth.jsx"),
    "@/lib/supabase/client": resolve(GEN, "client.js"),
    "@/components/my/VenueDiaryAddGameSheet": resolve(GEN, "null.jsx"),
    "@/components/my/VenueDiaryUploader": resolve(GEN, "null.jsx"),
    "@/components/my/VenueDiaryViewer": resolve(GEN, "null.jsx"),
    "@/components/ui/HeaderProfileLink": resolve(GEN, "null.jsx"),
    "next/link": resolve(GEN, "link.jsx"),
    "next/image": resolve(GEN, "image.jsx"),
    "next/navigation": resolve(GEN, "navigation.js"),
    "framer-motion": resolve(GEN, "motion.jsx"),
  },
});

// ── 픽스처 (W/L/D 3종이 반드시 한 화면에 같이 뜨도록 구성) ──────────────────
const today = new Date();
const iso = (offsetDays) => {
  const d = new Date(today);
  d.setDate(d.getDate() - offsetDays);
  return d.toISOString().slice(0, 10);
};
const monthPrefix = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

const teamCardPayload = {
  standing: { rank: 1, gamesBehind: 0, streak: "2승", above: null, below: null },
  recentForm: ["W", "L", "D"],
  nextGame: null,
};
const rosterMovesPayload = {
  moves: [
    { kboPlayerId: "1", playerName: "등록선수", moveType: "register", moveDate: iso(1), href: "/players/1" },
    { kboPlayerId: "2", playerName: "말소선수", moveType: "deregister", moveDate: iso(1), href: "/players/2" },
  ],
};
const gameLogsPayload = {
  rows: ["W", "L", "D"].map((result, i) => ({
    game_id: `g${i}`,
    game_date: iso(i + 1),
    team_code: "LG",
    opponent_team_id: 2,
    is_home: true,
    result,
    ab: 4, h: 2, hr: 1, rbi: 2, bb: 1, so: 0,
    ip_outs: 0, er: 0, h_allowed: 0, k: 0, bb_allowed: 0,
  })),
};
const attendancePayload = {
  season: 2026,
  summary: { attendanceCount: 3, wins: 1, losses: 1, draws: 1, finalCount: 3, winRate: 0.333 },
  overallSummary: { attendanceCount: 3, wins: 1, losses: 1, draws: 1, finalCount: 3, winRate: 0.333 },
  diaryGameCount: 3,
  games: ["W", "L", "D"].map((result, i) => ({
    id: i + 1,
    gameId: `d${i}`,
    date: iso(i + 1),
    stadium: "잠실",
    favoriteTeamId: 1,
    recordedAt: `${iso(i + 1)}T12:00:00Z`,
    source: "story_geofence",
    venueVerified: true,
    status: "active",
    result,
    awayTeam: { id: 2, name: "두산", score: 3 },
    homeTeam: { id: 1, name: "LG", score: 5 },
  })),
};
const diaryMediaPayload = {
  season: 2026,
  games: ["W", "L", "D"].map((_, i) => ({
    gameId: `d${i}`,
    gameDate: iso(i + 1),
    stadiumName: "잠실",
    counts: { image: 1, video: 0, total: 1 },
    thumbnails: [
      { id: i + 1, kind: "image", thumbUrl: null, source: "story_geofence", status: "active" },
    ],
  })),
  nextCursor: null,
  hasMore: false,
};
const schedulePayload = {
  team: "lg",
  month: monthPrefix,
  summary: { wins: 1, losses: 1, draws: 1, winRate: 0.5 },
  days: ["W", "L", "D"].map((result, i) => ({
    day: i + 1,
    date: `${monthPrefix}-0${i + 1}`,
    gameId: `s${i}`,
    opponent: { id: 2, slug: "doosan", shortName: "두산", name: "두산 베어스" },
    home: true,
    status: "final",
    result,
    score: { for: 5, against: 3 },
    stadium: "잠실",
  })),
};

const css = await postcss([tailwind]).process(
  readFileSync(resolve(ROOT, "src/styles/globals.css"), "utf8"),
  { from: resolve(ROOT, "src/styles/globals.css") },
);
const bundle = readFileSync(resolve(GEN, "bundle.js"), "utf8");

const json = (res, body) =>
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
const server = createServer((req, res) => {
  const url = req.url ?? "";
  if (url.startsWith("/api/team-card")) return json(res, teamCardPayload);
  if (url.startsWith("/api/roster-moves")) return json(res, rosterMovesPayload);
  if (url.startsWith("/api/stats")) return json(res, []);
  if (url.startsWith("/api/player-game-logs")) return json(res, gameLogsPayload);
  if (url.startsWith("/api/me/venue-attendance")) return json(res, attendancePayload);
  if (url.startsWith("/api/me/venue-diary/media")) return json(res, diaryMediaPayload);
  if (url.startsWith("/api/team-schedule")) return json(res, schedulePayload);
  if (url === "/app.css") return res.writeHead(200, { "content-type": "text/css" }).end(css.css);
  if (url === "/bundle.js")
    return res.writeHead(200, { "content-type": "text/javascript" }).end(bundle);
  if (url.startsWith("/logos/") && url.endsWith(".svg")) {
    const p = resolve(ROOT, `public${url}`);
    if (existsSync(p))
      return res.writeHead(200, { "content-type": "image/svg+xml" }).end(readFileSync(p));
    return res.writeHead(404).end();
  }
  res.writeHead(200, { "content-type": "text/html" }).end(
    '<!doctype html><html class="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body style="margin:0;background:#0A0A0B"><div id="root"></div><script src="/bundle.js"></script></body></html>',
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;

let browser;
try {
  browser = await playwright.chromium.launch();
} catch (error) {
  const line = String(error?.message ?? error).split("\n")[0];
  server.close();
  rmSync(GEN, { recursive: true, force: true });
  if (REQUIRE_BROWSER) {
    console.error(`FAIL: chromium launch 실패(fail-closed) — ${line}`);
    process.exit(1);
  }
  console.log(`SKIP: chromium launch 불가 — ${line}`);
  process.exit(0);
}
const page = await browser.newPage({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

const styleOf = (locator) =>
  locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, backgroundColor: s.backgroundColor, text: el.textContent?.trim() ?? "" };
  });

/**
 * 텍스트로 요소를 찾아 computed style 을 한 번에 스냅샷한다.
 * locator 를 잡아둔 뒤 React 가 re-render 하면 노드가 detach 되고
 * getComputedStyle 이 빈 문자열을 돌려준다(= 색을 못 읽는데 FAIL 로만 보임).
 * 조회와 측정을 같은 tick 안에서 끝내 그 race 를 없앤다.
 */
const snapshotByText = (page, pattern, tag = "*") =>
  page.evaluate(
    ({ pattern, tag }) => {
      const re = new RegExp(pattern);
      const out = [];
      for (const el of document.querySelectorAll(tag)) {
        const text = (el.textContent ?? "").trim();
        if (!re.test(text)) continue;
        // 같은 텍스트를 가진 조상까지 잡히지 않도록 leaf 만.
        if ([...el.children].some((c) => re.test((c.textContent ?? "").trim()))) continue;
        const s = getComputedStyle(el);
        const parent = el.parentElement;
        out.push({
          text,
          tag: el.tagName.toLowerCase(),
          color: s.color,
          backgroundColor: s.backgroundColor,
          parentBackgroundColor: parent ? getComputedStyle(parent).backgroundColor : "",
        });
      }
      return out;
    },
    { pattern, tag },
  );

/** 라벨(승/패/무) 3종이 각각 올바른 tone 색·배경으로 렌더되는지 */
async function assertResultChips(where, locators, { bg = true, soft = false } = {}) {
  const palette = soft ? EXPECT_SOFT : EXPECT_BASE;
  for (const [tone, locator] of Object.entries(locators)) {
    const count = await locator.count();
    if (count !== 1) {
      check(false, `${where} · ${tone} 요소가 정확히 1개여야 함 (got ${count}) — 렌더 자체가 없으면 색 검증이 무의미`);
      continue;
    }
    const st = await styleOf(locator.first());
    check(sameRgb(st.color, palette[tone]), `${where} · ${tone} 텍스트색 = ${palette[tone]} (got ${st.color})`);
    if (bg) {
      check(
        sameRgba(st.backgroundColor, EXPECT_BG[tone]),
        `${where} · ${tone} 배경 = ${EXPECT_BG[tone]} (got ${st.backgroundColor})`,
      );
    }
  }
}

try {
  // ── 0) 팔레트 exact + 매핑 계약 ───────────────────────────────────────────
  {
    const modBundle = resolve(GEN, "tone-node.mjs");
    await build({
      entryPoints: [toneEntry],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: modBundle,
      absWorkingDir: ROOT,
      tsconfig: resolve(ROOT, "tsconfig.json"),
      logLevel: "error",
    });
    const mod = await import(`file://${modBundle}`);
    for (const tone of ["positive", "negative", "neutral"]) {
      check(mod.RESULT_TONE_COLOR[tone] === EXPECT_BASE[tone], `palette base.${tone} = ${EXPECT_BASE[tone]} (got ${mod.RESULT_TONE_COLOR[tone]})`);
      check(mod.RESULT_TONE_COLOR_SOFT[tone] === EXPECT_SOFT[tone], `palette soft.${tone} = ${EXPECT_SOFT[tone]} (got ${mod.RESULT_TONE_COLOR_SOFT[tone]})`);
      check(mod.RESULT_TONE_BG[tone] === EXPECT_BG[tone], `palette bg.${tone} = ${EXPECT_BG[tone]} (got ${mod.RESULT_TONE_BG[tone]})`);
    }
    check(mod.gameResultTone("W") === "positive", "매핑 W → positive");
    check(mod.gameResultTone("L") === "negative", "매핑 L → negative");
    check(mod.gameResultTone("D") === "neutral", "매핑 D → neutral");
    check(mod.gameResultTone(null) === "neutral", "매핑 null → neutral(미정은 중립)");
    // soft 는 같은 계열이어야 한다: 빨강 계열이 초록 계열로 튀는 팔레트 교체를 차단.
    const hueOk = (hex, dominant) => {
      const [r, g, b] = hexToRgb(hex);
      return dominant === "g" ? g > r && g > b : r > g && r > b;
    };
    check(hueOk(mod.RESULT_TONE_COLOR_SOFT.positive, "g"), "soft.positive 는 초록 계열 유지");
    check(hueOk(mod.RESULT_TONE_COLOR_SOFT.negative, "r"), "soft.negative 는 빨강 계열 유지");
  }

  // ── 1) 기준 화면: 홈 TeamCard `최근 N경기` 칩 ────────────────────────────
  await page.goto(`http://127.0.0.1:${port}/teamcard`, { waitUntil: "domcontentloaded" });
  await page.getByText("최근 3경기").waitFor();
  {
    const chips = page.locator("span", { hasText: /^(승|패|무)$/ });
    await assertResultChips("홈 TeamCard(기준)", {
      positive: chips.filter({ hasText: /^승$/ }),
      negative: chips.filter({ hasText: /^패$/ }),
      neutral: chips.filter({ hasText: /^무$/ }),
    });
  }

  // ── 2) 팀 등록·말소 배지 ─────────────────────────────────────────────────
  await page.goto(`http://127.0.0.1:${port}/roster`, { waitUntil: "domcontentloaded" });
  await page.getByText("등록", { exact: true }).first().waitFor();
  {
    const reg = await styleOf(page.getByText("등록", { exact: true }).first());
    const der = await styleOf(page.getByText("말소", { exact: true }).first());
    check(sameRgb(reg.color, EXPECT_BASE.positive), `등록 배지색 = ${EXPECT_BASE.positive} (got ${reg.color})`);
    check(sameRgb(der.color, EXPECT_BASE.negative), `말소 배지색 = ${EXPECT_BASE.negative} (got ${der.color})`);
  }

  // ── 3) 선수 게임로그 결과 칩 ─────────────────────────────────────────────
  await page.goto(`http://127.0.0.1:${port}/playerlogs`, { waitUntil: "domcontentloaded" });
  await page.locator("span", { hasText: /^승$/ }).first().waitFor();
  {
    const chips = page.locator("span", { hasText: /^(승|패|무)$/ });
    await assertResultChips("선수 게임로그", {
      positive: chips.filter({ hasText: /^승$/ }).first(),
      negative: chips.filter({ hasText: /^패$/ }).first(),
      neutral: chips.filter({ hasText: /^무$/ }).first(),
    });
    // 최근 N경기 타일(div)도 같은 계약
    const tiles = page.locator("div", { hasText: /^(승|패|무)$/ });
    const tileW = tiles.filter({ hasText: /^승$/ }).last();
    if (await tileW.count()) {
      const st = await styleOf(tileW);
      check(sameRgb(st.color, EXPECT_BASE.positive), `선수 최근경기 타일 승 = ${EXPECT_BASE.positive} (got ${st.color})`);
    } else {
      check(false, "선수 최근경기 타일이 렌더되지 않음");
    }
  }

  // ── 4) 직관 다이어리: 요약 승/패/무 + 경기별 결과 칩 ─────────────────────
  await page.goto(`http://127.0.0.1:${port}/diary`, { waitUntil: "domcontentloaded" });
  await page.getByText("경기별 기록").waitFor();
  {
    // 다이어리는 attendance/media fetch 가 각각 settle 하며 re-render 한다 → locator 를 먼저
    // 잡아두면 노드가 detach 돼 getComputedStyle 이 빈 문자열을 돌려준다(색 불일치가 아니라
    // 측정 실패인데 FAIL 로만 보임). 조회와 측정을 같은 tick 안에서 끝낸다.
    const summary = await snapshotByText(page, "^1(승|패|무)$", "span");
    for (const [tone, label] of [
      ["positive", "1승"],
      ["negative", "1패"],
      ["neutral", "1무"],
    ]) {
      const hit = summary.find((e) => e.text === label);
      if (!hit) {
        check(false, `다이어리 요약 ${label} 미렌더 — fixture 가 화면에 도달하지 못함`);
        continue;
      }
      check(sameRgb(hit.color, EXPECT_BASE[tone]), `다이어리 요약 ${label} = ${EXPECT_BASE[tone]} (got ${hit.color})`);
    }

    const chips = await snapshotByText(page, "^(승|패|무)$", "span");
    check(
      chips.length >= 3,
      `다이어리 경기별 결과 칩 3종 렌더 (got ${chips.length}) — 0이면 이전 게이트의 false-green 재현`,
    );
    for (const [tone, label] of [
      ["positive", "승"],
      ["negative", "패"],
      ["neutral", "무"],
    ]) {
      const hit = chips.find((e) => e.text === label);
      if (!hit) {
        check(false, `다이어리 경기 칩 ${label} 미렌더`);
        continue;
      }
      check(
        sameRgb(hit.color, EXPECT_BASE[tone]),
        `다이어리 경기 칩 · ${label} 텍스트색 = ${EXPECT_BASE[tone]} (got ${hit.color})`,
      );
      check(
        sameRgba(hit.backgroundColor, EXPECT_BG[tone]),
        `다이어리 경기 칩 · ${label} 배경 = ${EXPECT_BG[tone]} (got ${hit.backgroundColor})`,
      );
    }
  }

  // ── 5) 팀 일정 캘린더: W/L/D 텍스트 + 배경(무승부 포함) ──────────────────
  await page.goto(`http://127.0.0.1:${port}/schedule`, { waitUntil: "domcontentloaded" });
  await page.locator("span", { hasText: /^W$/ }).first().waitFor();
  {
    for (const [code, tone] of [["W", "positive"], ["L", "negative"], ["D", "neutral"]]) {
      const label = page.locator("span", { hasText: new RegExp(`^${code}$`) }).first();
      if (!(await label.count())) {
        check(false, `일정 캘린더 ${code} 미렌더`);
        continue;
      }
      const st = await styleOf(label);
      check(sameRgb(st.color, EXPECT_BASE[tone]), `일정 캘린더 ${code} 텍스트 = ${EXPECT_BASE[tone]} (got ${st.color})`);
      // 셀 배경(부모 div) — 삼순 Blocker 3: D 도 중립 배경을 받아야 한다.
      const cellBg = await label.evaluate((el) => getComputedStyle(el.parentElement).backgroundColor);
      check(
        sameRgba(cellBg, EXPECT_BG[tone]),
        `일정 캘린더 ${code} 셀 배경 = ${EXPECT_BG[tone]} (got ${cellBg})`,
      );
    }
  }
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}

console.log(`\nresult-tone gate: pass=${pass} fail=${fail}`);
if (SWAP || UNWIRE) {
  console.log(`(mutation 모드: swap=${SWAP} unwire=${UNWIRE || "-"} → fail>0 이어야 정상)`);
}
process.exit(fail === 0 ? 0 : 1);
