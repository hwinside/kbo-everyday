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
import * as venueStatsFixture from "./fixtures/venue-stats-scope.mjs";
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
  // 삼순 3차: 배경까지 SSOT 로 묶으면서 문자열이 바뀌었다. 배경 파생생성(`${color}1f`)으로
  // 되돌리는 변형이므로 색만 보는 assert 로는 안 잡히고 배경 exact 가 있어야 잡힌다.
  roster: [
    "src/components/team/TeamRosterMovesCard.tsx",
    'style={resultToneChipStyle(isRegister ? "positive" : "negative")}',
    'style={{ color: isRegister ? "#34D399" : "#F87171", backgroundColor: isRegister ? "rgba(52,211,153,0.12)" : "rgba(248,113,113,0.12)" }}',
  ],
  // 삼순 #1068 2차 Blocker 1·2 — 아래 6개는 이전 게이트가 아예 마운트하지 않아
  // 하드코딩으로 되돌려도 46/0 초록이었다(삼순 결함주입로 재현됨).
  homemoves: [
    "src/components/home/TeamCard.tsx",
    'style={resultToneChipStyle(isRegister ? "positive" : "negative")}',
    'style={{ color: isRegister ? "#34D399" : "#F87171", backgroundColor: isRegister ? "rgba(59,130,246,0.20)" : "rgba(245,158,11,0.20)" }}',
  ],
  // 삼순 3차: dormant 하던 TeamDashboard 도 승=teamColor/패=회색이었다.
  teamdashboard: [
    "src/components/stats/TeamDashboard.tsx",
    "backgroundColor: resultToneChipStyle(\n                  gameResultTone(game.result as \"W\" | \"L\" | \"D\"),\n                ).backgroundColor,",
    'backgroundColor: game.result === "W" ? `${teamColor}20` : "rgba(255,255,255,0.03)",',
  ],
  // 삼순 3차 결함주입: 대시보드 MetricCard 증감 색을 역전해도 초록이었다.
  metriccard: [
    "src/components/my/VenueStatsDashboard.tsx",
    'trend.tone === "unavailable" ? undefined : resultToneTextStyle(trend.tone);',
    'trend.tone === "unavailable" ? undefined : resultToneTextStyle(trend.tone === "positive" ? "negative" : trend.tone === "negative" ? "positive" : trend.tone);',
  ],
  // 삼순 3차 결함주입: 요정 지수 축 색을 역전해도 초록이었다.
  scoreaxis: [
    "src/components/my/VenueStatsDashboard.tsx",
    "axis.normalized > 0.02\n                          ? \"positive\"\n                          : axis.normalized < -0.02\n                            ? \"negative\"\n                            : \"neutral\",",
    'axis.normalized > 0.02\n                          ? "negative"\n                          : axis.normalized < -0.02\n                            ? "positive"\n                            : "neutral",',
  ],
  addsheet: [
    "src/components/my/VenueDiaryAddGameSheet.tsx",
    "const resultStyle = resultToneTextStyle(gameResultTone(day.result));",
    'const resultStyle = { color: day.result === "W" ? "#3b82f6" : day.result === "L" ? "#FF453A" : "#8E8E93" };',
  ],
  uploader: [
    "src/components/my/VenueDiaryUploader.tsx",
    "  return resultToneChipStyle(gameResultTone(result));",
    '  return { color: result === "W" ? "#3b82f6" : result === "L" ? "#ef4444" : "#8E8E93", backgroundColor: "rgba(255,255,255,0.06)" };',
  ],
  viewer: [
    "src/components/my/VenueDiaryViewer.tsx",
    "  return resultToneChipStyle(gameResultTone(result));",
    '  return { color: result === "W" ? "#3b82f6" : result === "L" ? "#ef4444" : "#8E8E93", backgroundColor: "rgba(255,255,255,0.06)" };',
  ],
  dashboard: [
    "src/components/my/VenueStatsDashboard.tsx",
    "style={resultToneTextStyle(compatibility.tone)}",
    'style={{ color: "#36D399" }}',
  ],
  // 삼순 4차: 궁합 tone 만 **독립 역전**하는 변형. 위 `dashboard` 는 전부 초록 고정이라
  // "색이 2종 + 팔레트 안" 만 보던 구 게이트도 잡았지만, 역전은 두 색이 그대로 남아
  // 통과했다(69점이 빨간데 GREEN). known-value exact 가 생기면 이게 RED 여야 한다.
  compatswap: [
    "src/components/my/VenueStatsDashboard.tsx",
    "style={resultToneTextStyle(compatibility.tone)}",
    'style={resultToneTextStyle(compatibility.tone === "positive" ? "negative" : compatibility.tone === "negative" ? "positive" : compatibility.tone)}',
  ],
  gamestats: [
    "src/components/game/GameStatsTab.tsx",
    'win: { label: "승", tone: "positive" },\n    loss: { label: "패", tone: "negative" },',
    'win: { label: "승", tone: "negative" },\n    loss: { label: "패", tone: "positive" },',
  ],
  teamhero: [
    "src/components/team/TeamHero.tsx",
    '? resultToneTextStyle("positive")',
    '? { color: "#4ade80" }',
  ],
  decision: [
    "src/components/game/GameDecisionPitchers.tsx",
    'WIN: { label: "승", className: "", style: resultToneChipStyle("positive") },\n  LOSS: { label: "패", className: "", style: resultToneChipStyle("negative") },',
    'WIN: { label: "승", className: "bg-green-500/20 text-green-400" },\n  LOSS: { label: "패", className: "bg-red-500/20 text-red-400" },',
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
  let mutatedConsumer = src.replace(from, to);
  // temp 디렉터리에 복제된 소스의 상대 import 는 원본 디렉터리가 아니라 temp 기준으로
  // 해석된다. GameStatsTab의 유일한 상대 import를 기존 alias가 잡는 절대 경로로 바꾼다.
  if (rel === "src/components/game/GameStatsTab.tsx") {
    mutatedConsumer = mutatedConsumer.replace(
      'from "./RelayInningCard"',
      'from "@/components/game/RelayInningCard"',
    );
  }
  writeFileSync(out, mutatedConsumer);
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
writeFileSync(resolve(GEN, "safeback.js"), `export const useSafeBack=()=>()=>{};`);
writeFileSync(resolve(GEN, "theme.jsx"), `
export const useTheme=()=>({resolvedTheme:"dark",theme:"dark",setTheme:()=>{}});
export const ThemeProvider=({children})=><>{children}</>;`);
writeFileSync(resolve(GEN, "portal.js"), `export const createPortal=(node)=>node;`);

// ── entry: 경로별로 실제 컴포넌트 마운트 ────────────────────────────────────
// 삼순 #1068 2차 Blocker 2 — 이전엔 AddGameSheet/Uploader/Viewer 를 Null 로 대체하고
// Dashboard 는 import 조차 안 해서, 그 네 화면은 색을 되돌려도 게이트가 초록이었다.
// 이제 전부 실제로 마운트해 computed style 로 판정한다.
writeFileSync(resolve(GEN, "entry.jsx"), `
import React from "react";
import {createRoot} from "react-dom/client";
import TeamCard from "@/components/home/TeamCard";
import VenueDiaryCard from "@/components/my/VenueDiaryCard";
import PlayerGameLogs from "@/components/player/PlayerGameLogs";
import TeamRosterMovesCard from "@/components/team/TeamRosterMovesCard";
import SchedulePage from "@/app/(main)/teams/[teamId]/schedule/page";
import VenueDiaryAddGameSheet from "@/components/my/VenueDiaryAddGameSheet";
import VenueDiaryUploader from "@/components/my/VenueDiaryUploader";
import VenueDiaryViewer from "@/components/my/VenueDiaryViewer";
import VenueStatsDashboard from "@/components/my/VenueStatsDashboard";
import TeamHero from "@/components/team/TeamHero";
import GameStatsTab from "@/components/game/GameStatsTab";
import GameDecisionPitchers from "@/components/game/GameDecisionPitchers";
import TeamDashboard from "@/components/stats/TeamDashboard";
import {ThemeProvider} from "@/components/ThemeProvider";
import {getTeamById} from "@/lib/constants/teams";
const LG=getTeamById(1);
const DOOSAN=getTeamById(2);
const path=window.location.pathname;
const uploadGame=(result)=>({gameId:"d0",dateLabel:"2026.07.18 (금) · 잠실",matchLabel:"LG 5 : 3 두산",result,existingCount:0});
// 포털 기반 모달은 한 화면에 3개를 겹쳐 띄우면 실제 앱과 다른 상태가 된다.
// 경로별로 W/L/D를 하나씩 마운트하고 테스트가 세 경로를 모두 순회한다.
const routeResult=path.split("/").at(-1);
const Uploader=()=> <VenueDiaryUploader game={uploadGame(routeResult)} isOpen onBack={()=>{}} onClose={()=>{}} onUploaded={()=>{}}/>;
const Viewer=()=> <VenueDiaryViewer gameId={"d"+routeResult} header={{matchLabel:"LG 5 : 3 두산",dateLabel:"2026.07.18 · 잠실",result:routeResult}} isOpen onClose={()=>{}} onChanged={()=>{}}/>;
const App=
  path==="/teamcard" ? () => <TeamCard team={LG}/> :
  path==="/diary" ? VenueDiaryCard :
  path==="/playerlogs" ? () => <PlayerGameLogs playerId="53123" position="내야수" teamColor="#C30452"/> :
  path==="/roster" ? () => <TeamRosterMovesCard team={LG}/> :
  path==="/addsheet" ? () => <VenueDiaryAddGameSheet isOpen favoriteTeamId={1} countsByGame={new Map()} countsReady countsError={false} activeAttendanceGameIds={new Set()} onRetryCounts={()=>{}} onBack={()=>{}} onClose={()=>{}} onPick={()=>{}} onRecord={()=>{}}/> :
  path.startsWith("/uploader/") ? Uploader :
  path.startsWith("/viewer/") ? Viewer :
  path==="/dashboard" ? VenueStatsDashboard :
  path==="/teamdashboard" ? () => <TeamDashboard teamName="LG 트윈스" teamColor="#C30452" standing={{teamId:1,season:2026,rank:1,wins:50,losses:30,draws:2,pct:0.625,gb:0,streak:"3승",last10:"7-3-0"}}/> :
  path==="/teamhero" ? () => (
    <div>
      <TeamHero team={LG} standings={{rank:1,wins:50,losses:30,draws:2,winRate:".625",gb:"-",streak:"3승"}}/>
      <TeamHero team={DOOSAN} standings={{rank:5,wins:40,losses:40,draws:2,winRate:".500",gb:"8.0",streak:"2패"}}/>
    </div>
  ) :
  path==="/gamestats" ? () => <ThemeProvider><GameStatsTab stats={window.__GAME_STATS__} awayTeam={DOOSAN} homeTeam={LG}/></ThemeProvider> :
  path==="/decision" ? () => <GameDecisionPitchers pitchers={[
    {name:"승리투수",teamId:1,role:"WIN",record:"1-0",era:"1.80"},
    {name:"패전투수",teamId:2,role:"LOSS",record:"0-1",era:"5.40"},
  ]}/> :
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
    "@/components/my/VenueDiaryAddGameSheet": aliasFor(
      "src/components/my/VenueDiaryAddGameSheet.tsx",
    ),
    "@/components/my/VenueDiaryUploader": aliasFor(
      "src/components/my/VenueDiaryUploader.tsx",
    ),
    "@/components/my/VenueDiaryViewer": aliasFor(
      "src/components/my/VenueDiaryViewer.tsx",
    ),
    "@/components/my/VenueStatsDashboard": aliasFor(
      "src/components/my/VenueStatsDashboard.tsx",
    ),
    "@/components/stats/TeamDashboard": aliasFor("src/components/stats/TeamDashboard.tsx"),
    "@/components/team/TeamHero": aliasFor("src/components/team/TeamHero.tsx"),
    "@/components/game/GameStatsTab": aliasFor("src/components/game/GameStatsTab.tsx"),
    "@/components/game/GameDecisionPitchers": aliasFor("src/components/game/GameDecisionPitchers.tsx"),
    "@/components/ui/HeaderProfileLink": resolve(GEN, "null.jsx"),
    "@/components/game/RelayInningCard": resolve(GEN, "null.jsx"),
    "@/components/ThemeProvider": resolve(GEN, "theme.jsx"),
    "@/lib/hooks/useSafeBack": resolve(GEN, "safeback.js"),
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
const diaryDetailPayload = (gameId) => ({
  media: [
    {
      id: 1,
      gameId,
      mediaType: "image",
      mediaUrl: "/qa-diary-image.jpg",
      thumbUrl: null,
      caption: null,
      venueVerified: true,
      stadiumName: "잠실",
      createdAt: "2026-08-02T12:00:00Z",
      comments: [],
    },
  ],
});
// GameStatsTab 승/패 배지 — 한 화면에 win · loss 둘 다 띄운다.
const pitcher = (name, result) => ({
  name, result, ip: "5", h: 4, r: 2, er: 2, bb: 1, so: 5, hr: 0,
  bf: 20, ab: 18, np: 80, g: 1, w: 1, l: 0, sv: 0, hd: 0, era: "3.60",
});
const batter = (order, name) => ({
  order, name, position: "중", ab: 4, r: 1, h: 2, rbi: 1, hr: 0, bb: 0, so: 1, sb: 0, avg: ".300",
});
const gameStatsFixture = {
  gameId: "20260802LGOB0",
  away: {
    teamId: 2,
    batters: [batter(1, "정수빈")],
    pitchers: [pitcher("패전투수", "loss")],
  },
  home: {
    teamId: 1,
    batters: [batter(1, "홍창기")],
    pitchers: [pitcher("승리투수", "win")],
  },
};

// 직관 통계 대시보드 payload — s2-browser 와 **같은** fixture 모듈을 쓴다.
const venueStatsPayload = venueStatsFixture.payload;

/**
 * MetricCard(팀 타율/ERA/득점/홈런 4장)는 `hero.mixedTeam === false` 일 때만 렌더된다.
 * 공용 fixture 는 다중구단(mixed_team) 이라 그대로는 MetricCard 가 한 장도 안 그려졌고,
 * 그게 바로 삼순 3차 결함주입(증감 색 역전해도 87/0)의 원인이다.
 * 공용 fixture 를 건드리면 s2-browser 계약이 같이 바뀌므로, 여기서 **단일팀 변형**만 파생한다.
 * B1~B4 부호: 타율 ↑(positive) · ERA ↓(낮을수록 좋음 → positive) · 득점 ↑(positive) · 홈런 ↑(positive)
 * → negative 가 한 장도 없으면 "둘 다 나타나야 함" assert 가 못 잡으므로 ERA·홈런을 악화로 둠.
 */
const SINGLE_TEAM_METRIC_TONES = ["positive", "positive", "negative", "negative"];
const singleTeamVenueStatsPayload = (() => {
  const clone = structuredClone(venueStatsFixture.payload);
  for (const scopeName of ["overall", "gps"]) {
    const metrics = clone[scopeName].metrics;
    // A1 을 ready 로 내려 mixedTeam 을 끕다(그래야 MetricCard 그리드가 살아난다).
    metrics.A1 = { ...metrics.A1, state: "ready", items: undefined };
    // 부호를 명시적으로 고정 — 기대 tone 을 테스트가 산수로 재계산하지 않게 한다.
    metrics.B1 = venueStatsFixture.envelope("B1", { attendanceAvg: .286, seasonAvg: .263, delta: .023 });
    metrics.B3 = venueStatsFixture.envelope("B3", { runsPerGame: 5.2, seasonRunsPerGame: 4.6, delta: .6, totalRuns: 21 });
    // ERA 는 higherIsBetter=false → delta 가 양수면 악화 = negative.
    metrics.B2 = venueStatsFixture.envelope("B2", { attendanceEra: 4.60, seasonEra: 4.01, delta: .59 });
    // 홈런 감소 → negative.
    metrics.B4 = venueStatsFixture.envelope("B4", { hr: { attendancePerGame: .7, seasonPerGame: 1.0, delta: -.3 }, hitsAllowed: null });
  }
  return clone;
})();

const schedulePayload = {
  team: "lg",
  month: monthPrefix,
  summary: { wins: 1, losses: 1, draws: 1, winRate: 0.5 },
  // ⚠️ date 는 실제 route(`src/app/api/team-schedule/route.ts`) 계약대로 **YYYYMMDD**.
  // 이전 fixture 는 `2026-08-01` 형식이었는데, 일정 페이지는 `day` 만 써서 통과했고
  // 날짜를 실제로 파싱하는 추가 시트에서야 계약 불일치가 드러났다.
  days: ["W", "L", "D"].map((result, i) => ({
    day: i + 1,
    date: `${monthPrefix.replace("-", "")}0${i + 1}`,
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

// 대시보드를 단일팀 모드로 부팅할지. 게이트 본문이 네비게이션 직전에 뒤집는다.
// (서버가 테스트와 같은 프로세스라 모듈 변수로 충분하다.)
let singleTeamMode = false;

const json = (res, body) =>
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
const server = createServer((req, res) => {
  const url = req.url ?? "";
  if (url.startsWith("/api/team-card")) return json(res, teamCardPayload);
  if (url.startsWith("/api/roster-moves")) return json(res, rosterMovesPayload);
  if (url.startsWith("/api/stats")) return json(res, []);
  if (url.startsWith("/api/player-game-logs")) return json(res, gameLogsPayload);
  if (url.startsWith("/api/me/venue-attendance")) return json(res, attendancePayload);
  if (url.startsWith("/api/me/venue-diary/media")) {
    const gameId = new URL(url, "http://127.0.0.1").searchParams.get("gameId");
    return json(res, gameId ? diaryDetailPayload(gameId) : diaryMediaPayload);
  }
  if (url.startsWith("/api/team-schedule")) return json(res, schedulePayload);
  // 단일팀 변형은 MetricCard 그리드(팀 타율/ERA/득점/홈런)를 띄우기 위해서만 쓴다.
  // 공용 fixture 는 mixed_team 이라 그 그리드가 아예 렌더되지 않고, 그게 곰 삼순 3차
  // 결함주입(증감 색 역전해도 초록)의 원인이었다.
  if (url.startsWith("/api/me/venue-stats"))
    return json(res, singleTeamMode ? singleTeamVenueStatsPayload : venueStatsPayload);
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
    '<!doctype html><html class="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body style="margin:0;background:#0A0A0B"><div id="root"></div>' +
      `<script>window.__GAME_STATS__=${JSON.stringify(gameStatsFixture)};</script>` +
      '<script src="/bundle.js"></script></body></html>',
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
    await page.getByText("등록", { exact: true }).first().waitFor();
    const reg = await styleOf(page.getByText("등록", { exact: true }).first());
    const der = await styleOf(page.getByText("말소", { exact: true }).first());
    check(sameRgb(reg.color, EXPECT_BASE.positive), `홈 인라인 등록 = ${EXPECT_BASE.positive} (got ${reg.color})`);
    check(sameRgb(der.color, EXPECT_BASE.negative), `홈 인라인 말소 = ${EXPECT_BASE.negative} (got ${der.color})`);
    // 삼순 3차 결함주입: 색만 보면 배경을 blue/amber 로 바꿔도 초록이었다. 배경도 exact.
    check(
      sameRgba(reg.backgroundColor, EXPECT_BG.positive),
      `홈 인라인 등록 배경 = ${EXPECT_BG.positive} (got ${reg.backgroundColor})`,
    );
    check(
      sameRgba(der.backgroundColor, EXPECT_BG.negative),
      `홈 인라인 말소 배경 = ${EXPECT_BG.negative} (got ${der.backgroundColor})`,
    );
  }

  // ── 2) 팀 등록·말소 배지 ─────────────────────────────────────────────────
  await page.goto(`http://127.0.0.1:${port}/roster`, { waitUntil: "domcontentloaded" });
  await page.getByText("등록", { exact: true }).first().waitFor();
  {
    const reg = await styleOf(page.getByText("등록", { exact: true }).first());
    const der = await styleOf(page.getByText("말소", { exact: true }).first());
    check(sameRgb(reg.color, EXPECT_BASE.positive), `등록 배지색 = ${EXPECT_BASE.positive} (got ${reg.color})`);
    check(sameRgb(der.color, EXPECT_BASE.negative), `말소 배지색 = ${EXPECT_BASE.negative} (got ${der.color})`);
    check(
      sameRgba(reg.backgroundColor, EXPECT_BG.positive),
      `등록 배지 배경 = ${EXPECT_BG.positive} (got ${reg.backgroundColor})`,
    );
    check(
      sameRgba(der.backgroundColor, EXPECT_BG.negative),
      `말소 배지 배경 = ${EXPECT_BG.negative} (got ${der.backgroundColor})`,
    );
  }

  // ── 2-1) dormant TeamDashboard 최근 10경기 (삼순 3차) ────────────────────
  // import 0 이지만 유지할 컴포넌트라 승=teamColor/패=회색을 SSOT 로 수렴시켰다.
  await page.goto(`http://127.0.0.1:${port}/teamdashboard`, { waitUntil: "domcontentloaded" });
  await page.getByText("최근 10경기").waitFor();
  {
    const cells = await snapshotByText(page, "^(W|L|D)$", "span");
    for (const [code, tone] of [["W", "positive"], ["L", "negative"]]) {
      const hit = cells.find((e) => e.text === code);
      if (!hit) {
        check(false, `TeamDashboard ${code} 미렌더`);
        continue;
      }
      check(
        sameRgb(hit.color, EXPECT_BASE[tone]),
        `TeamDashboard ${code} = ${EXPECT_BASE[tone]} (got ${hit.color})`,
      );
      const cellBg = await page
        .locator("span", { hasText: new RegExp(`^${code}$`) })
        .first()
        .evaluate((el) => getComputedStyle(el.parentElement).backgroundColor);
      check(
        sameRgba(cellBg, EXPECT_BG[tone]),
        `TeamDashboard ${code} 셀 배경 = ${EXPECT_BG[tone]} (got ${cellBg})`,
      );
    }
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

  // ── 6) 지난경기 추가 시트 (삼순 2차 Blocker 2) ────────────────────────────
  await page.goto(`http://127.0.0.1:${port}/addsheet`, { waitUntil: "domcontentloaded" });
  await page.getByText("지난 경기 추가").first().waitFor();
  {
    const rows = await snapshotByText(page, "^(승|패|무)$", "span");
    check(rows.length >= 3, `추가 시트 결과 텍스트 3종 렌더 (got ${rows.length})`);
    for (const [tone, label] of [["positive", "승"], ["negative", "패"], ["neutral", "무"]]) {
      const hit = rows.find((e) => e.text === label);
      if (!hit) {
        check(false, `추가 시트 ${label} 미렌더`);
        continue;
      }
      check(
        sameRgb(hit.color, EXPECT_BASE[tone]),
        `추가 시트 · ${label} = ${EXPECT_BASE[tone]} (got ${hit.color})`,
      );
    }
  }

  // ── 7) 다이어리 업로더 헤더 칩 ──────────────────────────────────────────
  {
    for (const [result, tone, label] of [["W", "positive", "승"], ["L", "negative", "패"], ["D", "neutral", "무"]]) {
      await page.goto(`http://127.0.0.1:${port}/uploader/${result}`, { waitUntil: "domcontentloaded" });
      await page.getByText("LG 5 : 3 두산").first().waitFor();
      const chips = await snapshotByText(page, `^${label}$`, "span");
      const hit = chips.find((e) => e.text === label);
      if (!hit) {
        check(false, `업로더 ${label} 미렌더`);
        continue;
      }
      check(sameRgb(hit.color, EXPECT_BASE[tone]), `업로더 · ${label} 텍스트색 = ${EXPECT_BASE[tone]} (got ${hit.color})`);
      check(sameRgba(hit.backgroundColor, EXPECT_BG[tone]), `업로더 · ${label} 배경 = ${EXPECT_BG[tone]} (got ${hit.backgroundColor})`);
    }
  }

  // ── 8) 다이어리 뷰어 헤더 칩 ────────────────────────────────────────────
  {
    for (const [result, tone, label] of [["W", "positive", "승"], ["L", "negative", "패"], ["D", "neutral", "무"]]) {
      await page.goto(`http://127.0.0.1:${port}/viewer/${result}`, { waitUntil: "domcontentloaded" });
      await page.getByText("LG 5 : 3 두산").first().waitFor({ timeout: 8000 }).catch(async (error) => {
        console.log(`  [viewer-debug] ${await page.locator("body").innerText()}`);
        throw error;
      });
      const chips = await snapshotByText(page, `^${label}$`, "span");
      const hit = chips.find((e) => e.text === label);
      if (!hit) {
        check(false, `뷰어 ${label} 미렌더`);
        continue;
      }
      check(sameRgb(hit.color, EXPECT_BASE[tone]), `뷰어 · ${label} 텍스트색 = ${EXPECT_BASE[tone]} (got ${hit.color})`);
      check(sameRgba(hit.backgroundColor, EXPECT_BG[tone]), `뷰어 · ${label} 배경 = ${EXPECT_BG[tone]} (got ${hit.backgroundColor})`);
    }
  }

  // ── 9) 직관 통계 대시보드 — soft variant 계약 ──────────────────────────────
  // 삼순 결함주입: 궁합 점수를 positive/negative/neutral 모두 초록 하나로 고정해도
  // 기존 게이트가 전부 초록이었다(대비만 보므로). 여기서 의미색을 값으로 본다.
  await page.goto(`http://127.0.0.1:${port}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("venue-favorite-card").first().waitFor({ timeout: 8000 });
  {
    const attendance = await snapshotByText(page, "^\\d+(승|패|무)$", "span");
    for (const [tone, suffix] of [["positive", "승"], ["negative", "패"], ["neutral", "무"]]) {
      const hit = attendance.find((e) => e.text.endsWith(suffix));
      if (!hit) {
        check(false, `대시보드 히어로 ${suffix} 미렌더`);
        continue;
      }
      check(
        sameRgb(hit.color, EXPECT_SOFT[tone]),
        `대시보드 히어로 ${hit.text} = soft ${EXPECT_SOFT[tone]} (got ${hit.color})`,
      );
    }

    // ── 9-1) 요정 지수 축 (삼순 3차 결함주입 대상) ─────────────────────
    // 축은 화면에 ▲/▼/→ 를 직접 그리므로 방향→의미 결속을 그대로 exact 검증할 수 있다.
    // ⚠️ `전체 기록` 스코프 fixture 는 초과성과가 전부 양수라 ▲만 나온다. 그러면
    //    positive→negative 단방향 역전을 못 잡으므로 `GPS 인증만`(음수 초과성과) 탭까지
    //    돌아 ▲·▼ 를 둘 다 확보한다. 한 탭만 보면 그게 곧 false-green 이다.
    {
      let sawPositive = false;
      let sawNegative = false;
      for (const scopeLabel of ["전체 기록", "GPS 인증만"]) {
        const tab = page.getByRole("button", { name: scopeLabel });
        if (await tab.count()) await tab.first().click();
        await page.getByTestId("venue-score-axis").first().waitFor({ timeout: 8000 });
        const axes = await page.getByTestId("venue-score-axis").evaluateAll((els) =>
          els.map((el) => ({ text: (el.textContent ?? "").trim(), color: getComputedStyle(el).color })),
        );
        check(axes.length > 0, `요정 지수 축 렌더 · ${scopeLabel} (got ${axes.length})`);
        for (const axis of axes) {
          const tone = axis.text.startsWith("\u25b2")
            ? "positive"
            : axis.text.startsWith("\u25bc")
              ? "negative"
              : "neutral";
          if (tone === "positive") sawPositive = true;
          if (tone === "negative") sawNegative = true;
          check(
            sameRgb(axis.color, EXPECT_SOFT[tone]),
            `지수 축 · ${scopeLabel} "${axis.text}" tone=${tone} → soft ${EXPECT_SOFT[tone]} (got ${axis.color})`,
          );
        }
      }
      check(
        sawPositive && sawNegative,
        `지수 축에 ▲·▼ 가 둘 다 관측돼야 역전을 잡는다 (▲=${sawPositive} ▼=${sawNegative})`,
      );
      // 뒤 단계(궁합 점수)는 기본 스코프 기준이므로 되돌린다.
      const back = page.getByRole("button", { name: "전체 기록" });
      if (await back.count()) await back.first().click();
    }

    // ── 9-1b) 궁합 점수 known-value exact (삼순 4차 blocker) ────────────────
    // 이전 판본은 "색이 2종 이상 + 팔레트 안" 만 봤다. 그래서 궁합 tone 만 독립 역전하면
    // 초록/빨강 두 색이 그대로 나타나고 팔레트 안에도 있으니 110/0 GREEN 이었다
    // (삼순 실측: 69점이 빨강인데 통과). 점수 → 기대 tone 을 값으로 못박는다.
    //
    // 기대값은 fixture 를 모듈 공식(batterCompatibility/pitcherCompatibility)에 넣어
    // 산출한 실측 상수다. 모듈에서 import 하면 구현이 바뀔 때 기대값도 따라 움직여
    // tautology 가 되므로 여기에 상수로 적는다.
    //   53123 타자 69 / p3 타자 62 / p4 타자 39 / p2 투수 71 / p5 투수 60
    //   tone 경계: >=56 positive · <=44 negative · 그 사이 neutral
    const EXPECT_COMPAT_TONE = { 69: "positive", 62: "positive", 39: "negative", 71: "positive", 60: "positive" };
    const toggle = page.getByRole("button", { name: "다른 최애 4명 보기" });
    if (await toggle.count()) await toggle.click();
    const compat = await page.getByTestId("venue-compatibility-score").evaluateAll((els) =>
      els.map((el) => ({
        // 점수 노드는 "69점" 형태(숫자 + 접미 span). 숫자만 뽑는다.
        text: (el.textContent ?? "").trim(),
        color: getComputedStyle(el).color,
      })),
    );
    check(
      compat.length === Object.keys(EXPECT_COMPAT_TONE).length,
      `궁합 점수 ${Object.keys(EXPECT_COMPAT_TONE).length}개 렌더 — 개수가 다르면 fixture 계약이 어긋난 것 (got ${compat.length})`,
    );
    const compatPalette = {
      positive: hexToRgb(EXPECT_BASE.positive).join(","),
      negative: hexToRgb(EXPECT_BASE.negative).join(","),
      neutral: hexToRgb(EXPECT_BASE.neutral).join(","),
    };
    let sawCompatPositive = false;
    let sawCompatNegative = false;
    for (const entry of compat) {
      const scoreMatch = entry.text.match(/^(\d+)/);
      check(scoreMatch != null, `궁합 점수 텍스트에서 숫자 추출 (got "${entry.text}")`);
      if (!scoreMatch) continue;
      const score = Number(scoreMatch[1]);
      const tone = EXPECT_COMPAT_TONE[score];
      // 기대표에 없는 점수 = fixture 나 공식이 바뀐 것. 조용히 넘기면 그게 false-green 이다.
      check(tone != null, `궁합 점수 ${score} 가 기대표에 있어야 함(공식/fixture 변경 감지)`);
      if (tone == null) continue;
      if (tone === "positive") sawCompatPositive = true;
      if (tone === "negative") sawCompatNegative = true;
      const got = parseComputed(entry.color);
      check(
        got != null && [got[0], got[1], got[2]].join(",") === compatPalette[tone],
        `궁합 ${score}점 tone=${tone} → ${EXPECT_BASE[tone]} (got ${entry.color})`,
      );
    }
    // 한 방향만 있으면 단방향 역전을 못 잡는다.
    check(
      sawCompatPositive && sawCompatNegative,
      `궁합에 positive·negative 가 둘 다 있어야 역전을 잡는다 (positive=${sawCompatPositive} negative=${sawCompatNegative})`,
    );
  }

  // ── 9-2) MetricCard 증감 톤 (삼순 3차 결함주입 대상) ──────────────────
  // 삼순이 positive↔negative 를 역전해도 87/0 초록이었다. 원인은 공용 fixture 가 mixed_team 이라
  // MetricCard 그리드가 **한 장도 렌더되지 않았던 것** — 전형적인 "안 그려져서 통과".
  // 단일팀 payload 로 다시 띄워 known-value exact 로 묶는다.
  // ▲/▼ 방향과 tone 은 독립이므로(ERA 는 ▼가 positive) 화살표로 tone 을 유추하지 않고,
  // fixture 에서 부호를 명시적으로 고정해 기대 tone 을 상수로 둔다.
  singleTeamMode = true;
  await page.goto(`http://127.0.0.1:${port}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("venue-team-metrics").first().waitFor({ timeout: 8000 });
  {
    const trends = await page.getByTestId("venue-metric-trend").evaluateAll((els) =>
      els.map((el) => ({ text: (el.textContent ?? "").trim(), color: getComputedStyle(el).color })),
    );
    check(
      trends.length === SINGLE_TEAM_METRIC_TONES.length,
      `MetricCard ${SINGLE_TEAM_METRIC_TONES.length}장 렌더 — 0 이면 삼순이 잡은 "안 그려져서 통과" 재현 (got ${trends.length})`,
    );
    const palette = {
      positive: hexToRgb(EXPECT_BASE.positive).join(","),
      negative: hexToRgb(EXPECT_BASE.negative).join(","),
      neutral: hexToRgb(EXPECT_BASE.neutral).join(","),
    };
    for (let i = 0; i < Math.min(SINGLE_TEAM_METRIC_TONES.length, trends.length); i += 1) {
      const tone = SINGLE_TEAM_METRIC_TONES[i];
      const got = parseComputed(trends[i].color);
      check(
        got != null && [got[0], got[1], got[2]].join(",") === palette[tone],
        `MetricCard[${i}] "${trends[i].text}" tone=${tone} → ${EXPECT_BASE[tone]} (got ${trends[i].color})`,
      );
    }
    // positive 와 negative 가 둘 다 화면에 있어야 역전 mutation 이 잡힌다.
    const shown = new Set(
      trends
        .map((t) => parseComputed(t.color))
        .filter(Boolean)
        .map((c) => [c[0], c[1], c[2]].join(",")),
    );
    check(
      shown.has(palette.positive) && shown.has(palette.negative),
      `MetricCard 에 positive·negative 가 둘 다 나타나야 함 (got ${[...shown].join(" / ")})`,
    );
  }
  singleTeamMode = false;
  // ── 10) 팀 헤더 연승/연패 ─────────────────────────────────────────────────
  await page.goto(`http://127.0.0.1:${port}/teamhero`, { waitUntil: "domcontentloaded" });
  await page.getByText("3승", { exact: true }).first().waitFor();
  {
    const streaks = await snapshotByText(page, "^\\d+(승|패)$", "p");
    const win = streaks.find((e) => e.text.endsWith("승"));
    const loss = streaks.find((e) => e.text.endsWith("패"));
    check(!!win, "팀 헤더 연승 렌더");
    check(!!loss, "팀 헤더 연패 렌더");
    if (win) check(sameRgb(win.color, EXPECT_BASE.positive), `팀 헤더 연승 = ${EXPECT_BASE.positive} (got ${win.color})`);
    if (loss) check(sameRgb(loss.color, EXPECT_BASE.negative), `팀 헤더 연패 = ${EXPECT_BASE.negative} (got ${loss.color})`);
  }

  // ── 11) 경기 기록 투수 승/패 배지 ───────────────────────────────────────────
  // 삼순 Blocker 1: 여긴 승=red-500 · 패=blue-500 로 앱 전체와 정반대였다.
  await page.goto(`http://127.0.0.1:${port}/gamestats`, { waitUntil: "domcontentloaded" });
  {
    await page.getByText("패전투수").first().waitFor();
    const loss = (await snapshotByText(page, "^패$", "span")).find((e) => e.text === "패");
    check(!!loss, "경기기록 투수 패 배지 렌더");
    if (loss) {
      check(
        sameRgb(loss.color, EXPECT_BASE.negative),
        `경기기록 투수 패 배지 = ${EXPECT_BASE.negative} (got ${loss.color})`,
      );
      check(
        sameRgba(loss.backgroundColor, EXPECT_BG.negative),
        `경기기록 투수 패 배경 = ${EXPECT_BG.negative} (got ${loss.backgroundColor})`,
      );
    }

    await page.getByRole("button", { name: "LG" }).click();
    await page.getByText("승리투수").first().waitFor();
    const win = (await snapshotByText(page, "^승$", "span")).find((e) => e.text === "승");
    check(!!win, "경기기록 투수 승 배지 렌더");
    if (win) {
      check(
        sameRgb(win.color, EXPECT_BASE.positive),
        `경기기록 투수 승 배지 = ${EXPECT_BASE.positive} (got ${win.color})`,
      );
      check(
        sameRgba(win.backgroundColor, EXPECT_BG.positive),
        `경기기록 투수 승 배경 = ${EXPECT_BG.positive} (got ${win.backgroundColor})`,
      );
    }
  }

  // ── 12) 결정 투수 승/패 배지 ──────────────────────────────────────────────
  await page.goto(`http://127.0.0.1:${port}/decision`, { waitUntil: "domcontentloaded" });
  await page.getByText("결정 투수", { exact: true }).waitFor();
  {
    const badges = await snapshotByText(page, "^(승|패)$", "span");
    for (const [tone, label] of [["positive", "승"], ["negative", "패"]]) {
      const hit = badges.find((e) => e.text === label);
      check(!!hit, `결정 투수 ${label} 배지 렌더`);
      if (!hit) continue;
      check(sameRgb(hit.color, EXPECT_BASE[tone]), `결정 투수 ${label} = ${EXPECT_BASE[tone]} (got ${hit.color})`);
      check(sameRgba(hit.backgroundColor, EXPECT_BG[tone]), `결정 투수 ${label} 배경 = ${EXPECT_BG[tone]} (got ${hit.backgroundColor})`);
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
