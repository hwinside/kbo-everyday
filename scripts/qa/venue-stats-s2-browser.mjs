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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = process.cwd();
const GEN = mkdtempSync(resolve(tmpdir(), "venue-stats-s2-"));
const SHOT = resolve(ROOT, "tmp/qa-screenshots/venue-stats-s2-390.png");
mkdirSync(resolve(ROOT, "tmp/qa-screenshots"), { recursive: true });

writeFileSync(resolve(GEN, "auth.jsx"), `
export const useAuth=()=>({
  user:{id:"qa",email:"harinclaw@gmail.com"},
  profile:{favorite_players:[
    {playerId:"p1",name:"김최애",teamId:1,position:"내야수"},
    {playerId:"p2",name:"이최애",teamId:9,position:"투수"}
  ]}
});`);
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
  const teamValue = {
    b1:{attendanceAvg:.286,seasonAvg:.263,delta:.023},
    b2:{attendanceEra:3.42,seasonEra:4.01,delta:-.59},
    b3:{runsPerGame:5.2,totalRuns:21},
    b4:{hr:{attendancePerGame:1.3,seasonPerGame:1.0,delta:.3},hitsAllowed:null},
  };
  for (const id of ["B1","B2","B3","B4"]) {
    metrics[id] = {...envelope(id, null),state:"mixed_team",items:[
      {key:"1",state:"ready",value:teamValue,n:4,denominator:{}},
      {key:"9",state:"ready",value:teamValue,n:4,denominator:{}},
    ]};
  }
  metrics.C1 = envelope("C1", [{playerId:"p1",attendanceAvg:.333,seasonAvg:.278,deltaAvg:.055,attendanceHrPerGame:.2,seasonHrPerGame:.1,attendanceRbiPerGame:1,seasonRbiPerGame:.7,appearances:6,ab:21}], {attendanceAB:21});
  metrics.C2 = envelope("C2", [{playerId:"p2",attendanceEra:2.71,seasonEra:3.88,eraImprovement:1.17,attendanceK9:9.2,seasonK9:8.1,k9Delta:1.1,appearances:4,outs:40}], {attendanceOuts:40});
  metrics.C4 = envelope("C4", [{playerId:"p1",homeRuns:2,appearanceGames:6}]);
  metrics.C5 = envelope("C5", [{playerId:"p1",batterTop:{gameId:"g",date:"2026-07-12",ab:4,h:3,hr:1,rbi:3,bb:1}}]);
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

const css = await postcss([tailwind]).process(
  readFileSync(resolve(ROOT, "src/styles/globals.css"), "utf8"),
  { from: resolve(ROOT, "src/styles/globals.css") },
);
const bundle = readFileSync(resolve(GEN, "bundle.js"), "utf8");
const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/me/venue-stats")) {
    return res.writeHead(200, {"content-type":"application/json"}).end(JSON.stringify(payload));
  }
  if (req.url === "/app.css") return res.writeHead(200, {"content-type":"text/css"}).end(css.css);
  if (req.url === "/bundle.js") return res.writeHead(200, {"content-type":"text/javascript"}).end(bundle);
  res.writeHead(200, {"content-type":"text/html"}).end(
    '<!doctype html><html class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>',
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });

try {
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "domcontentloaded" });
  await page.getByText("63", { exact: true }).waitFor();
  const body = await page.locator("body").innerText();
  if (!body.includes("LG 응원 구간") || !body.includes("한화 응원 구간")) throw new Error("mixed-team segments missing");
  if ((await page.evaluate(() => document.documentElement.scrollWidth)) > 390) throw new Error("horizontal overflow");
  await page.getByRole("button", { name: "GPS 인증만" }).click();
  await page.getByText("38", { exact: true }).waitFor();
  await page.screenshot({ path: SHOT, fullPage: true });
  console.log(`venue stats S2 browser: PASS (390px, scope switch, mixed-team segments)\nshot: ${SHOT}`);
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}
