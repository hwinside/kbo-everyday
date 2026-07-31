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
const stalePayload = {
  season:2025,
  seasonSupport:{status:"attendance_only",supportedSeason:2026},
  overall:scope("overall",2,.25),
  gps:scope("gps",1,.125),
};

const css = await postcss([tailwind]).process(
  readFileSync(resolve(ROOT, "src/styles/globals.css"), "utf8"),
  { from: resolve(ROOT, "src/styles/globals.css") },
);
const bundle = readFileSync(resolve(GEN, "bundle.js"), "utf8");
let initial2026Served = false;
const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/me/venue-stats")) {
    const requestedSeason = new URL(req.url, "http://127.0.0.1").searchParams.get("season");
    const body = requestedSeason === "2025" ? stalePayload : payload;
    const delay = requestedSeason === "2025" ? 300 : initial2026Served ? 10 : 0;
    if (requestedSeason === "2026") initial2026Served = true;
    return setTimeout(() => {
      if (!res.destroyed) {
        res.writeHead(200, {"content-type":"application/json"}).end(JSON.stringify(body));
      }
    }, delay);
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

  const staleRequest = page.waitForRequest((request) => request.url().includes("season=2025"));
  await page.locator("select").selectOption("2025");
  await staleRequest;
  await page.locator("select").selectOption("2026");
  await page.getByText("63", { exact: true }).waitFor();
  await page.waitForTimeout(400);
  if ((await page.locator("select").inputValue()) !== "2026") throw new Error("season selection rolled back");
  if (await page.getByText("25", { exact: true }).isVisible()) throw new Error("stale 2025 response overwrote 2026");

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
  console.log(
    `venue stats S2 browser: PASS (390px, B1~B4 actual payload, season abort/generation, AA ${contrast.minimum.toFixed(2)}:1 across ${contrast.count} texts)\nshot: ${SHOT}`,
  );
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}
