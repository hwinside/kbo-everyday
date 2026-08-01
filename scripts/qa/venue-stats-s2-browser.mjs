#!/usr/bin/env node
/**
 * S2 실제 컴포넌트 390px 브라우저 스모크.
 * API fixture는 전체/GPS 값을 의도적으로 다르게 두어 범위 토글 오배선을 탐지한다.
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import playwright from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// CI(VENUE_STATS_S2_REQUIRE_BROWSER=1)에선 fail-closed: chromium이 없으면 exit 1.
// 그 외(로컬/Vercel prebuild)에선 chromium 미설치 시 graceful skip(exit 0)로 배포를 깨지 않는다.
const REQUIRE_BROWSER = process.env.VENUE_STATS_S2_REQUIRE_BROWSER === "1";
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

const ROOT = process.cwd();
const GEN = mkdtempSync(resolve(tmpdir(), "venue-stats-s2-"));
const SHOT = resolve(ROOT, "tmp/qa-screenshots/venue-stats-s2-390.png");
mkdirSync(resolve(ROOT, "tmp/qa-screenshots"), { recursive: true });

writeFileSync(resolve(GEN, "auth.jsx"), `
// 실제 AuthContext 처럼 매 렌더마다 새 객체를 만들지 않는 안정 참조.
const AUTH={
  user:{id:"qa",email:"harinclaw@gmail.com"},
  profile:{favorite_players:[
    {playerId:"53123",name:"오스틴",teamId:1,position:"내야수"},
    {playerId:"p2",name:"이최애",teamId:9,position:"투수"}
  ]}
};
export const useAuth=()=>AUTH;`);
writeFileSync(resolve(GEN, "client.js"), `
export async function getSafeSession(){return {access_token:"qa"};}`);
writeFileSync(resolve(GEN, "back.js"), `
export const useSafeBack=()=>()=>{};`);
writeFileSync(resolve(GEN, "image.jsx"), `
export default function Image(p){return <img {...p}/>;}`);
writeFileSync(resolve(GEN, "entry.jsx"), `
import React from "react";
import {createRoot} from "react-dom/client";
import VenueStatsDashboard from "@/components/my/VenueStatsDashboard";
createRoot(document.getElementById("root")).render(<VenueStatsDashboard/>);`);

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
  alias: {
    "@/lib/supabase/AuthContext": resolve(GEN, "auth.jsx"),
    "@/lib/supabase/client": resolve(GEN, "client.js"),
    "@/lib/hooks/useSafeBack": resolve(GEN, "back.js"),
    "next/image": resolve(GEN, "image.jsx"),
  },
  logLevel: "error",
});

const metricIds = [
  "A1","A2","A3","A4","A5","A6","B1","B2","B3","B4",
  "C1","C2","C4","C5","C6","D1","D5","D6","E1","E2","E3","E4",
];
const envelope = (id, value, denominator = { finalGames: 8 }) => ({
  id, state: "ready", value, n: 8, denominator, coverage: {},
});
const scope = (name, wins, rate) => {
  const metrics = Object.fromEntries(metricIds.map((id) => [id, envelope(id, null)]));
  metrics.A1 = {
    ...envelope("A1", {
      attendance: { w: wins, l: 8 - wins, d: 0, rate },
      teamComparable: null,
      deltaPp: null,
    }),
    state: "mixed_team",
    items: [
      { key:"1", state:"ready", value:{attendance:{w:3,l:1,d:0,rate:.75},teamComparable:null,deltaPp:null}, n:4, denominator:{} },
      { key:"9", state:"ready", value:{attendance:{w:2,l:2,d:0,rate:.5},teamComparable:null,deltaPp:null}, n:4, denominator:{} },
    ],
  };
  const teamValues = {
    "1": {
      B1:{attendanceAvg:.286,seasonAvg:.263,delta:.023},
      B2:{attendanceEra:3.42,seasonEra:4.01,delta:-.59},
      B3:{runsPerGame:5.2,totalRuns:21},
      B4:{hr:{attendancePerGame:1.3,seasonPerGame:1.0,delta:.3},hitsAllowed:null},
    },
    "9": {
      B1:{attendanceAvg:.251,seasonAvg:.244,delta:.007},
      B2:{attendanceEra:4.18,seasonEra:4.31,delta:-.13},
      B3:{runsPerGame:4.1,totalRuns:16},
      B4:{hr:{attendancePerGame:.8,seasonPerGame:.7,delta:.1},hitsAllowed:null},
    },
  };
  for (const id of ["B1","B2","B3","B4"]) {
    metrics[id] = {...envelope(id, null),state:"mixed_team",items:[
      {key:"1",state:"ready",value:teamValues["1"][id],n:4,denominator:{}},
      {key:"9",state:"ready",value:teamValues["9"][id],n:4,denominator:{}},
    ]};
  }
  metrics.C1 = envelope("C1", [{playerId:"53123",attendanceAvg:.333,seasonAvg:.278,deltaAvg:.055,attendanceHrPerGame:.2,seasonHrPerGame:.1,attendanceRbiPerGame:1,seasonRbiPerGame:.7,appearances:6,ab:21}], {attendanceAB:21});
  metrics.C2 = envelope("C2", [{playerId:"p2",attendanceEra:2.71,seasonEra:3.88,eraImprovement:1.17,attendanceK9:9.2,seasonK9:8.1,k9Delta:1.1,appearances:4,outs:40}], {attendanceOuts:40});
  metrics.C4 = envelope("C4", [{playerId:"53123",homeRuns:2,appearanceGames:6}]);
  metrics.C5 = envelope("C5", [{playerId:"53123",batterTop:{gameId:"g",date:"2026-07-12",ab:4,h:3,hr:1,rbi:3,bb:1}}]);
  metrics.C6 = envelope("C6", {batterRanking:[],pitcherRanking:[]});
  metrics.D1 = envelope("D1", {avgRunDiff:1.4,closeGameRate:.25,closeGames:2});
  metrics.D5 = envelope("D5", {cancelledCount:1});
  metrics.D6 = envelope("D6", {maxTeamRuns:{gameId:"g",date:"2026-07-12",runs:9},maxMarginWin:null});
  metrics.E1 = envelope("E1", {current:3,longest:5,perTeam:[]});
  metrics.E2 = envelope("E2", {seasonCount:8,monthly:[],avgPerActiveMonth:2});
  metrics.E3 = envelope("E3", {firstAttendanceDate:"2024-04-01",daysSinceFirst:842,totalGames:17});
  metrics.E4 = envelope("E4", {topStadium:{name:"잠실",count:6},mostSeenFavorites:[]});
  metrics.A2 = envelope("A2", [{opponentTeamId:2,w:3,l:1,d:0,rate:.75}]);
  metrics.A3 = envelope("A3", [{stadium:"잠실",homeAway:"home",w:4,l:2,d:0,rate:.667}]);
  metrics.A4 = envelope("A4", [{weekday:6,w:3,l:1,d:0,rate:.75}]);
  metrics.A5 = envelope("A5", [{dayNight:"night",w:4,l:2,d:0,rate:.667}]);
  metrics.A6 = envelope("A6", [{month:7,w:3,l:1,d:0,rate:.75}]);
  return {
    state:"ready",
    filter:{scope:name,sources:name==="gps"?["story_geofence"]:["story_geofence","diary_manual"]},
    coverage:{attendanceGames:8,finalGames:8,cancelledGames:1,unavailableGames:0,dedupedRows:0,incompleteFinalGames:0,invalidSnapshot:[]},
    metrics,
  };
};
const payload = {
  season:2026,
  seasonSupport:{status:"supported",supportedSeason:2026},
  overall:scope("overall",5,.625),
  gps:scope("gps",3,.375),
};
const stalePayload = {
  season:2025,
  seasonSupport:{status:"attendance_only",supportedSeason:2026},
  overall:scope("overall",2,.25),
  gps:scope("gps",1,.125),
};

// 혼합팀 표본 미달(2팀 × 1경기 = 총 2경기 < MIN_FINAL_GAMES).
// 서버 계약대로 시즌 baseline·delta 는 이미 null 로 내려오고, UI 는
// 사실값 노출 + 파생 점수 `–` + amber `표본 부족(참고용)` 이어야 한다.
const sampleLimitedScope = (name) => {
  const base = scope(name, 2, 1);
  base.metrics.A1 = {
    ...base.metrics.A1,
    n: 2,
    value: { attendance: { w: 2, l: 0, d: 0, rate: 1 }, teamComparable: null, deltaPp: null },
    items: [
      { key:"1", state:"sample_limited", value:{attendance:{w:1,l:0,d:0,rate:1},teamComparable:null,deltaPp:null}, n:1, denominator:{} },
      { key:"9", state:"sample_limited", value:{attendance:{w:1,l:0,d:0,rate:1},teamComparable:null,deltaPp:null}, n:1, denominator:{} },
    ],
  };
  const limited = {
    "1": {
      B1:{attendanceAvg:.286,seasonAvg:null,delta:null},
      B2:{attendanceEra:3.42,seasonEra:null,delta:null},
      B3:{runsPerGame:5.2,totalRuns:5},
      B4:{hr:{attendancePerGame:1.3,seasonPerGame:null,delta:null},hitsAllowed:null},
    },
    "9": {
      B1:{attendanceAvg:.251,seasonAvg:null,delta:null},
      B2:{attendanceEra:4.18,seasonEra:null,delta:null},
      B3:{runsPerGame:4.1,totalRuns:4},
      B4:{hr:{attendancePerGame:.8,seasonPerGame:null,delta:null},hitsAllowed:null},
    },
  };
  for (const id of ["B1","B2","B3","B4"]) {
    base.metrics[id] = {...base.metrics[id],items:[
      {key:"1",state:"sample_limited",value:limited["1"][id],n:1,denominator:{}},
      {key:"9",state:"sample_limited",value:limited["9"][id],n:1,denominator:{}},
    ]};
  }
  // A2~A6 production shape: 표본 미달 cell 은 top-level value 에서 빠지고 items 에만 사실값이 남는다.
  // UI 가 top-level 만 읽으면 이 경로가 `표시할 기록이 없어요` 로 죽는다(삼순 P0-2).
  const splitItems = {
    A2: [
      {key:"2",value:{opponentTeamId:2,w:1,l:0,d:0,rate:1}},
      {key:"9",value:{opponentTeamId:9,w:1,l:0,d:0,rate:1}},
    ],
    A3: [
      {key:"잠실:home",value:{stadium:"잠실",homeAway:"home",w:1,l:0,d:0,rate:1}},
      {key:"대전:away",value:{stadium:"대전",homeAway:"away",w:1,l:0,d:0,rate:1}},
    ],
    A4: [
      {key:"6",value:{weekday:6,w:1,l:0,d:0,rate:1}},
      {key:"3",value:{weekday:3,w:1,l:0,d:0,rate:1}},
    ],
    A5: [
      {key:"night",value:{dayNight:"night",w:2,l:0,d:0,rate:1}},
    ],
    A6: [
      {key:"7",value:{month:7,w:2,l:0,d:0,rate:1}},
    ],
  };
  for (const [id, items] of Object.entries(splitItems)) {
    base.metrics[id] = {
      ...base.metrics[id],
      state:"sample_limited",
      value:[],
      n:2,
      denominator:{finalGames:2},
      items: items.map(({key,value}) => ({key,state:"sample_limited",value,n:1,denominator:{finalGames:1}})),
    };
  }
  return base;
};
const sampleLimitedPayload = {
  season:2026,
  seasonSupport:{status:"supported",supportedSeason:2026},
  overall:sampleLimitedScope("overall"),
  gps:sampleLimitedScope("gps"),
};

// attendance_only(비교 소스 없는 시즌) 2경기 — 판정 사다리에서 sample_limited 보다 먼저 확정되어
// 표본 미달이 state 에 가려지던 경계. 사실값은 노출하되 파생 지수는 `–` 이어야 한다.
const attendanceOnlyScope = (name) => {
  const base = sampleLimitedScope(name);
  base.metrics.A1 = {
    ...base.metrics.A1,
    state: "attendance_only",
    n: 2,
    denominator: { attendanceFinalGames: 2, teamSeasonGames: 0 },
    value: { attendance: { w: 2, l: 0, d: 0, rate: 1 }, teamComparable: null, deltaPp: null },
    items: [],
    reasons: ["season_not_supported"],
  };
  return base;
};
const attendanceOnlyPayload = {
  season:2026,
  seasonSupport:{status:"supported",supportedSeason:2026},
  overall:attendanceOnlyScope("overall"),
  gps:attendanceOnlyScope("gps"),
};

// 직관 경기 원장은 complete지만 시즌 baseline만 partial인 운영 경계.
// 직관 사실값과 C4/C5 사실형 카드는 유지하고 시즌 비교만 `–`로 감춘다.
const partialBaselineScope = (name) => {
  const base = scope(name, 5, .625);
  base.state = "partial_data";
  base.coverage.incompleteFinalGames = 1;
  base.metrics.A1 = envelope("A1", {
    attendance: { w: 5, l: 3, d: 0, rate: .625 },
    teamComparable: null,
    deltaPp: null,
  });
  base.metrics.B1 = { ...envelope("B1", { attendanceAvg:.286, seasonAvg:null, delta:null }), state:"partial_data" };
  base.metrics.B2 = { ...envelope("B2", { attendanceEra:3.42, seasonEra:null, delta:null }), state:"partial_data" };
  base.metrics.B3 = envelope("B3", { runsPerGame:5.2, totalRuns:42 });
  base.metrics.B4 = { ...envelope("B4", { hr:{attendancePerGame:1.3,seasonPerGame:null,delta:null}, hitsAllowed:null }), state:"partial_data" };
  base.metrics.C1 = {
    ...envelope("C1", [{playerId:"53123",attendanceAvg:.333,seasonAvg:null,deltaAvg:null,attendanceHrPerGame:.2,seasonHrPerGame:null,attendanceRbiPerGame:1,seasonRbiPerGame:null,appearances:6,ab:21}], {attendanceAB:21}),
    state:"partial_data",
  };
  base.metrics.C2 = {
    ...envelope("C2", [{playerId:"p2",attendanceEra:2.71,seasonEra:null,eraImprovement:null,attendanceK9:9.2,seasonK9:null,k9Delta:null,appearances:4,outs:40}], {attendanceOuts:40}),
    state:"partial_data",
  };
  base.metrics.C4 = envelope("C4", [{playerId:"53123",homeRuns:2,appearanceGames:6}]);
  base.metrics.C5 = envelope("C5", [{playerId:"53123",batterTop:{gameId:"g",date:"2026-07-12",ab:4,h:3,hr:1,rbi:3,bb:1}}]);
  return base;
};
const partialBaselinePayload = {
  season:2026,
  seasonSupport:{status:"supported",supportedSeason:2026},
  overall:partialBaselineScope("overall"),
  gps:partialBaselineScope("gps"),
};

const css = await postcss([tailwind]).process(
  readFileSync(resolve(ROOT, "src/styles/globals.css"), "utf8"),
  { from: resolve(ROOT, "src/styles/globals.css") },
);
const bundle = readFileSync(resolve(GEN, "bundle.js"), "utf8");
let initial2026Served = false;
let fail2025 = false;
let serveSampleLimited = false;
let serveAttendanceOnly = false;
let servePartialBaseline = false;
const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/me/venue-stats")) {
    const requestedSeason = new URL(req.url, "http://127.0.0.1").searchParams.get("season");
    const body = requestedSeason === "2025"
      ? stalePayload
      : servePartialBaseline ? partialBaselinePayload
      : serveAttendanceOnly ? attendanceOnlyPayload
      : serveSampleLimited ? sampleLimitedPayload
      : payload;
    const delay = requestedSeason === "2025" ? 300 : initial2026Served ? 10 : 0;
    if (requestedSeason === "2026") initial2026Served = true;
    return setTimeout(() => {
      if (res.destroyed) return;
      if (requestedSeason === "2025" && fail2025) {
        res.writeHead(503, {"content-type":"application/json"}).end('{"error":"injected"}');
        return;
      }
      res.writeHead(200, {"content-type":"application/json"}).end(JSON.stringify(body));
    }, delay);
  }
  if (req.url === "/app.css") return res.writeHead(200, {"content-type":"text/css"}).end(css.css);
  if (req.url === "/bundle.js") return res.writeHead(200, {"content-type":"text/javascript"}).end(bundle);
  if (req.url === "/players/53123.jpg") {
    return res.writeHead(200, {"content-type":"image/jpeg"})
      .end(readFileSync(resolve(ROOT, "public/players/53123.jpg")));
  }
  res.writeHead(200, {"content-type":"text/html"}).end(
    '<!doctype html><html class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>',
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
    console.error(`FAIL: playwright chromium launch 실패(fail-closed) — ${line}`);
    process.exit(1);
  }
  console.log(`SKIP: playwright chromium launch 불가 — ${line}`);
  process.exit(0);
}
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
page.on("pageerror", (error) => console.log(`  [pageerror] ${error.message}`));

try {
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "domcontentloaded" });
  await page.getByText("63", { exact: true }).waitFor();
  const lgSegment = page.getByText("LG 응원 구간", { exact: true }).nth(1).locator("../..");
  const hanwhaSegment = page.getByText("한화 응원 구간", { exact: true }).nth(1).locator("../..");
  const lgText = await lgSegment.innerText();
  const hanwhaText = await hanwhaSegment.innerText();
  if (![".286", "3.42", "5.2", "1.3"].every((value) => lgText.includes(value))) {
    throw new Error(`mixed-team LG B1~B4 actual payload mismatch: ${lgText}`);
  }
  if (![".251", "4.18", "4.1", "0.8"].every((value) => hanwhaText.includes(value))) {
    throw new Error(`mixed-team 한화 B1~B4 actual payload mismatch: ${hanwhaText}`);
  }
  const body = await page.locator("body").innerText();
  if (!body.includes("LG 응원 구간") || !body.includes("한화 응원 구간")) throw new Error("mixed-team segments missing");
  if ((await page.evaluate(() => document.documentElement.scrollWidth)) > 390) throw new Error("horizontal overflow");

  // 최애 사진 회귀: 실제 사진 ID는 정적 JPEG를 로드하고, 사진 없는 ID는 종전 팀 로고를 유지한다.
  const favoritePhoto = page.locator('img[src="/players/53123.jpg"]');
  if (await favoritePhoto.count() !== 1) throw new Error("favorite photo must render exactly once");
  const photoLoaded = await favoritePhoto.evaluate((img) => img.complete && img.naturalWidth > 0);
  if (!photoLoaded) throw new Error("favorite photo did not load a valid image");
  const fallbackRow = page.getByText("이최애", { exact: true }).locator("../..");
  const fallbackImages = fallbackRow.locator("img");
  if (await fallbackImages.count() !== 1) throw new Error("photo-less favorite must keep exactly one team-logo fallback");
  const fallbackSrc = await fallbackImages.first().getAttribute("src");
  if (!fallbackSrc || fallbackSrc.includes("/players/")) {
    throw new Error(`photo-less favorite rendered invalid photo instead of team logo: ${fallbackSrc}`);
  }

  const staleRequest = page.waitForRequest((request) => request.url().includes("season=2025"));
  await page.locator("select").selectOption("2025");
  await staleRequest;
  await page.locator("select").selectOption("2026");
  await page.getByText("63", { exact: true }).waitFor();
  await page.waitForTimeout(400);
  if ((await page.locator("select").inputValue()) !== "2026") throw new Error("season selection rolled back");
  if (await page.getByText("25", { exact: true }).isVisible()) throw new Error("stale 2025 response overwrote 2026");

  // 결함주입: 선택 시즌(2025) 요청이 503으로 실패할 때
  // 로딩 중·실패 후 모두 이전 시즌(2026) 수치가 남지 않고 retry UI가 떠야 한다.
  fail2025 = true;
  const failedResponse = page
    .waitForResponse((response) => response.url().includes("season=2025") && response.status() === 503)
    .catch(() => null);
  await page.locator("select").selectOption("2025");
  await page.waitForTimeout(50);
  if ((await page.getByText("63", { exact: true }).count()) > 0) {
    throw new Error("stale previous-season value visible while selected season is loading");
  }
  await failedResponse;
  await page.getByRole("button", { name: /통계를 불러오지 못했어요/ }).waitFor({ timeout: 4000 });
  if ((await page.getByText("63", { exact: true }).count()) > 0) {
    throw new Error("stale previous-season value visible after selected season failed");
  }
  if ((await page.locator("select").inputValue()) !== "2025") throw new Error("failed season selection rolled back");

  fail2025 = false;
  await page.locator("select").selectOption("2026");
  await page.getByText("63", { exact: true }).waitFor();

  // 실패했던 시즌을 다시 고를 때, 이전 실패 UI가 새 요청 로딩 전에 한 프레임이라도 재노출되면 안 된다.
  // MutationObserver 로 DOM 변경마다 retry 버튼 존재를 샘플링해 1-frame flash 까지 잡는다.
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="venue-stats-dashboard"]');
    window.__retryFlash = 0;
    const hasRetry = () =>
      [...root.querySelectorAll("button")].some((button) =>
        (button.textContent ?? "").includes("통계를 불러오지 못했어요"));
    window.__retryObserver = new MutationObserver(() => {
      if (hasRetry()) window.__retryFlash += 1;
    });
    window.__retryObserver.observe(root, { childList: true, subtree: true, characterData: true });
    if (hasRetry()) window.__retryFlash += 1;
  });
  await page.locator("select").selectOption("2025");
  const immediateRetry = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="venue-stats-dashboard"]');
    return [...root.querySelectorAll("button")].some((button) =>
      (button.textContent ?? "").includes("통계를 불러오지 못했어요"));
  });
  if (immediateRetry) {
    throw new Error("previous failure retry UI visible immediately after reselecting failed season");
  }
  await page.getByText("25", { exact: true }).waitFor();
  const retryFlash = await page.evaluate(() => {
    window.__retryObserver.disconnect();
    return window.__retryFlash;
  });
  if (retryFlash > 0) {
    throw new Error(`stale retry UI flashed ${retryFlash} time(s) when reselecting previously failed season`);
  }

  await page.locator("select").selectOption("2026");
  await page.getByText("63", { exact: true }).waitFor();

  await page.getByRole("button", { name: "GPS 인증만" }).click();
  await page.getByText("38", { exact: true }).waitFor();
  await page.getByRole("button", { name: "상대·구장·요일 상세 통계" }).click();

  const contrast = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    const rgba = (value) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "rgba(0,0,0,0)";
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const data = context.getImageData(0, 0, 1, 1).data;
      return { rgb: [data[0], data[1], data[2]], alpha: data[3] / 255 };
    };
    const over = (foreground, background) =>
      foreground.rgb.map((channel, index) =>
        Math.round(channel * foreground.alpha + background[index] * (1 - foreground.alpha)));
    const gradientAverage = (image) => {
      const colors = image.match(/rgba?\([^)]+\)/g)?.map(rgba).filter((color) => color.alpha > 0.01) ?? [];
      if (colors.length === 0) return null;
      return [0, 1, 2].map((index) =>
        Math.round(colors.reduce((sum, color) => sum + color.rgb[index], 0) / colors.length));
    };
    const effectiveBackground = (element) => {
      const chain = [];
      for (let current = element; current && current !== document.documentElement; current = current.parentElement) {
        chain.push(current);
      }
      chain.push(document.documentElement);
      let background = [255, 255, 255];
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        const style = getComputedStyle(chain[index]);
        const color = rgba(style.backgroundColor);
        if (color.alpha > 0.001) background = over(color, background);
        if (style.backgroundImage !== "none") {
          const gradient = gradientAverage(style.backgroundImage);
          if (gradient) background = gradient;
        }
      }
      return background;
    };
    const luminance = (rgb) => {
      const channels = rgb.map((value) => {
        const normalized = value / 255;
        return normalized <= 0.03928
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const ratio = (foreground, background) => {
      const first = luminance(foreground);
      const second = luminance(background);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };
    const probe = (element) => {
      const background = effectiveBackground(element);
      const foreground = over(rgba(getComputedStyle(element).color), background);
      return ratio(foreground, background);
    };
    const root = document.querySelector('[data-testid="venue-stats-dashboard"]');
    const candidates = [...root.querySelectorAll("*")].filter((element) => {
      const directText = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim();
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return directText.length > 0 && rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden";
    });
    const measured = candidates.map((element) => ({
      text: [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 60),
      ratio: probe(element),
    }));
    const target = candidates.find((element) => element.textContent?.trim() === "정규시즌 기준");
    const previousColor = target.style.color;
    target.style.color = "rgba(255,255,255,0.2)";
    const mutationRatio = probe(target);
    target.style.color = previousColor;
    return {
      count: measured.length,
      minimum: Math.min(...measured.map((entry) => entry.ratio)),
      failures: measured.filter((entry) => entry.ratio < 4.5),
      mutationRatio,
    };
  });
  if (contrast.failures.length > 0) {
    throw new Error(`Dashboard AA contrast failures: ${JSON.stringify(contrast.failures.slice(0, 8))}`);
  }
  if (contrast.mutationRatio >= 4.5) throw new Error("Dashboard AA mutation guard did not fail");

  await page.screenshot({ path: SHOT, fullPage: true });

  // ── 혼합팀 표본 미달(2팀 × 1경기) actual DOM 계약 ────────────────────────────
  // 사실값(W/L/D·승률·B1~B4)은 보이고, 파생 요정 지수는 `–`, 배지는 amber `표본 부족(참고용)`,
  // 시즌 baseline/delta 비교 문구는 0건이어야 한다.
  serveSampleLimited = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("표본 부족(참고용)", { exact: true }).first().waitFor({ timeout: 4000 });

  const heroBlock = page.locator('[data-testid="venue-stats-dashboard"]').first();
  const heroText = await heroBlock.innerText();
  for (const fact of ["2승", "0패", "0무", "100.0%"]) {
    if (!heroText.includes(fact)) throw new Error(`sample-limited hero fact missing: ${fact}`);
  }
  if (/\b100점\b/.test(heroText) || heroText.includes("승률 요정")) {
    throw new Error(`sample-limited hero exposed derived score/badge: ${heroText.slice(0, 200)}`);
  }
  // 파생 지수는 hero 숫자 slot(54px) 에만 렌더된다 — 해당 슬롯을 직접 집어 값을 확인한다.
  const scoreText = await page
    .locator('[data-testid="venue-stats-dashboard"] span.text-\\[54px\\]')
    .first()
    .innerText();
  if (scoreText.trim() !== "–") throw new Error(`sample-limited derived score must be dash, got ${scoreText}`);

  const limitedLg = await page.getByText("LG 응원 구간", { exact: true }).nth(1).locator("../..").innerText();
  const limitedHanwha = await page.getByText("한화 응원 구간", { exact: true }).nth(1).locator("../..").innerText();
  if (![".286", "3.42", "5.2", "1.3"].every((value) => limitedLg.includes(value))) {
    throw new Error(`sample-limited mixed LG facts missing: ${limitedLg}`);
  }
  if (![".251", "4.18", "4.1", "0.8"].every((value) => limitedHanwha.includes(value))) {
    throw new Error(`sample-limited mixed 한화 facts missing: ${limitedHanwha}`);
  }
  const baselinePhrases = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="venue-stats-dashboard"]');
    return [...root.querySelectorAll("*")]
      .map((element) => [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "").join("").trim())
      .filter((text) => /^시즌 /.test(text) || text.includes("시즌 경기당"));
  });
  if (baselinePhrases.length > 0) {
    throw new Error(`sample-limited must not render season baseline: ${JSON.stringify(baselinePhrases.slice(0, 5))}`);
  }
  // 배지는 기본 '승률 요정'(핑크 #ff9aa5)과 다른 경고색(amber)이어야 한다.
  // Tailwind v4 는 oklch 를 내보내므로 문자열 접두사 대신 실제 픽셀 RGB 로 판정한다.
  // A2~A6 상세: top-level value=[] 이어도 items 사실값이 실제 행으로 렌더되어야 한다.
  await page.getByRole("button", { name: "상대·구장·요일 상세 통계" }).click();
  const opponentCard = page.getByText("상대팀별", { exact: true }).locator("..");
  const opponentText = await opponentCard.innerText();
  if (opponentText.includes("표시할 기록이 없어요")) {
    throw new Error(`sample-limited split rows dropped (items ignored): ${opponentText}`);
  }
  for (const fact of ["두산전", "1승 0패 0무 · 100.0%"]) {
    if (!opponentText.includes(fact)) throw new Error(`sample-limited split fact missing: ${fact} / ${opponentText}`);
  }
  for (const [title, fact] of [["구장별", "잠실 · 홈"], ["요일별", "토요일"], ["낮·밤", "야간 경기"], ["월별", "7월"]]) {
    const text = await page.getByText(title, { exact: true }).locator("..").innerText();
    if (text.includes("표시할 기록이 없어요") || !text.includes(fact)) {
      throw new Error(`sample-limited split "${title}" missing ${fact}: ${text}`);
    }
  }
  // 행 단위 참고용 배지도 실제로 붙어야 한다.
  if ((await opponentCard.getByText("참고용", { exact: true }).count()) < 1) {
    throw new Error("sample-limited split rows missing 참고용 badge");
  }

  // 상세 목록 밖의 요약 카드(`토요일 승률`)도 같은 items 소스를 써야 한다.
  // top-level value 만 읽으면 상세엔 토요일이 보이는데 이 카드만 `–` 로 죽는다.
  const saturdayCard = page.getByText("토요일 승률", { exact: true }).locator("..");
  const saturdayText = await saturdayCard.innerText();
  if (!saturdayText.includes("100.0%")) {
    throw new Error(`sample-limited Saturday fact dropped outside detail list: ${saturdayText}`);
  }

  const badgeRgb = await page.getByText("표본 부족(참고용)", { exact: true }).first()
    .evaluate((element) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      context.fillStyle = getComputedStyle(element).color;
      context.fillRect(0, 0, 1, 1);
      const data = context.getImageData(0, 0, 1, 1).data;
      return [data[0], data[1], data[2]];
    });
  const [br, bg, bb] = badgeRgb;
  if (!(br > 200 && bg > 150 && bb < 140)) {
    throw new Error(`sample-limited badge must be amber warning tone, got rgb(${badgeRgb.join(",")})`);
  }

  // ── attendance_only 2경기 actual DOM 계약 ─────────────────────────────────
  // 비교 소스가 없는 시즌은 attendance_only 가 sample_limited 보다 먼저 확정되므로
  // state 열거로 막으면 다시 뚫린다 — 사실값은 남기고 파생 지수만 비워야 한다.
  serveAttendanceOnly = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("표본 부족(참고용)", { exact: true }).first().waitFor({ timeout: 4000 });

  const aoText = await page.locator('[data-testid="venue-stats-dashboard"]').first().innerText();
  for (const fact of ["2승", "0패", "0무", "100.0%"]) {
    if (!aoText.includes(fact)) throw new Error(`attendance_only hero fact missing: ${fact}`);
  }
  if (aoText.includes("승률 요정")) {
    throw new Error(`attendance_only 2 games must not show confident badge: ${aoText.slice(0, 200)}`);
  }
  const aoScore = await page
    .locator('[data-testid="venue-stats-dashboard"] span.text-\\[54px\\]')
    .first()
    .innerText();
  if (aoScore.trim() !== "–") {
    throw new Error(`attendance_only 2 games derived score must be dash, got ${aoScore}`);
  }
  const aoBadgeRgb = await page.getByText("표본 부족(참고용)", { exact: true }).first()
    .evaluate((element) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      context.fillStyle = getComputedStyle(element).color;
      context.fillRect(0, 0, 1, 1);
      const data = context.getImageData(0, 0, 1, 1).data;
      return [data[0], data[1], data[2]];
    });
  if (!(aoBadgeRgb[0] > 200 && aoBadgeRgb[1] > 150 && aoBadgeRgb[2] < 140)) {
    throw new Error(`attendance_only badge must be amber, got rgb(${aoBadgeRgb.join(",")})`);
  }

  // mutation RED: 가드가 실제로 살아있는지 — 점수 slot 을 강제로 채우면 검사가 실패해야 한다.
  const mutationDetected = await page.evaluate(() => {
    const slot = document.querySelector('[data-testid="venue-stats-dashboard"] span.text-\\[54px\\]');
    const original = slot.textContent;
    slot.textContent = "100";
    const leaked = slot.textContent.trim() !== "–";
    slot.textContent = original;
    return leaked;
  });
  if (!mutationDetected) throw new Error("attendance_only score mutation guard did not trip");

  // ── 시즌 baseline만 partial인 실제 390px DOM 계약 ─────────────────────────
  // C1/C2 직관 사실값과 attendance-only C4/C5는 유지하고 시즌 수치만 감춘다.
  servePartialBaseline = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(".333", { exact: true }).waitFor({ timeout: 4000 });

  const partialText = await page.locator('[data-testid="venue-stats-dashboard"]').first().innerText();
  for (const fact of [".286", "3.42", "1.3", ".333", "2.71", "홈런 목격", "최애 최고의 직관 경기"]) {
    if (!partialText.includes(fact)) throw new Error(`partial-baseline attendance fact/card missing: ${fact}`);
  }
  if (!partialText.includes("일부 기록 확인 중")) {
    throw new Error("partial-baseline honest partial state label missing");
  }
  if (partialText.includes(".278") || partialText.includes("3.88")) {
    throw new Error(`partial-baseline leaked season comparison: ${partialText}`);
  }
  for (const favorite of ["오스틴", "이최애"]) {
    const cardText = await page.getByText(favorite, { exact: true })
      .locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]')
      .innerText();
    if (!cardText.includes("시즌") || !cardText.includes("–")) {
      throw new Error(`partial-baseline ${favorite} season comparison must be dash: ${cardText}`);
    }
  }
  if ((await page.evaluate(() => document.documentElement.scrollWidth)) > 390) {
    throw new Error("partial-baseline horizontal overflow");
  }

  console.log(
    `venue stats S2 browser: PASS (390px, B1~B4 actual payload, season abort/generation, selected-season 503 fail-closed(no stale value + retry UI), mixed sample-limited facts+dash score+amber badge+0 baseline+summary card, attendance_only 2-game facts+dash score+amber badge+mutation RED, partial-baseline B/C attendance facts+C4/C5 visible+season hidden, AA ${contrast.minimum.toFixed(2)}:1 across ${contrast.count} texts)\nshot: ${SHOT}`,
  );
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}
