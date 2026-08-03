#!/usr/bin/env node
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import playwright from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REQUIRE_BROWSER = process.env.PLAYER_POPULARITY_REQUIRE_BROWSER === "1";
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
const GEN = mkdtempSync(resolve(tmpdir(), "player-popularity-browser-"));
const componentPath = resolve(ROOT, "src/components/onboarding/PlayerSelectModal.tsx");
let componentEntry = componentPath;
if (process.env.PLAYER_POPULARITY_MUTATE_LATE_RESPONSE === "1") {
  const source = readFileSync(componentPath, "utf8");
  const guard = "if (stale || settled) return;\n        settled = true;\n        setPopularity(";
  if (source.split(guard).length - 1 !== 1) throw new Error("late-response mutation target drifted");
  componentEntry = resolve(GEN, "PlayerSelectModal-mutated.tsx");
  writeFileSync(componentEntry, source.replace(
    guard,
    "if (stale) return;\n        settled = true;\n        setPopularity(",
  ));
}
writeFileSync(resolve(GEN, "auth.jsx"), `
export const useAuth=()=>({user:{id:"qa"},profile:null,loading:false});`);
writeFileSync(resolve(GEN, "empty.jsx"), `export default function Empty(){return null;}`);
writeFileSync(resolve(GEN, "avatar.jsx"), `
export default function Avatar({name}){return <span aria-hidden="true">⚾</span>;}`);
writeFileSync(resolve(GEN, "badge.jsx"), `
export default function Badge({teamId}){return <span>팀 {teamId}</span>;}`);
writeFileSync(resolve(GEN, "image.jsx"), `
export default function Image({unoptimized,...props}){return <img {...props}/>;}`);
writeFileSync(resolve(GEN, "motion.jsx"), `
import React from "react";
const strip=({initial,animate,exit,transition,...rest})=>rest;
const make=(tag)=>React.forwardRef((props,ref)=>React.createElement(tag,{...strip(props),ref}));
export const motion=new Proxy({},{get:(_,tag)=>make(tag)});`);
writeFileSync(resolve(GEN, "entry.jsx"), `
import React from "react";
import {createRoot} from "react-dom/client";
import PlayerSelectModal from "@/components/onboarding/PlayerSelectModal";
createRoot(document.getElementById("root")).render(
  <PlayerSelectModal isOpen={true} teamId={6} onComplete={()=>{}} onSkip={()=>{}} />
);`);

await build({
  entryPoints: [resolve(GEN, "entry.jsx")], bundle: true, format: "iife",
  outfile: resolve(GEN, "bundle.js"), jsx: "automatic", absWorkingDir: ROOT,
  nodePaths: [resolve(ROOT, "node_modules")], tsconfig: resolve(ROOT, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
  alias: {
    "@/lib/supabase/AuthContext": resolve(GEN, "auth.jsx"),
    "@/components/auth/LoginSheet": resolve(GEN, "empty.jsx"),
    "@/components/onboarding/PlayerSelectModal": componentEntry,
    "@/components/ui/PlayerAvatar": resolve(GEN, "avatar.jsx"),
    "@/components/ui/TeamBadge": resolve(GEN, "badge.jsx"),
    "next/image": resolve(GEN, "image.jsx"),
    "framer-motion": resolve(GEN, "motion.jsx"),
  }, logLevel: "error",
});

const globals = resolve(ROOT, "src/styles/globals.css");
const css = (await postcss([tailwind]).process(
  `@source "${componentEntry}";\n${readFileSync(globals, "utf8")}`,
  { from: globals },
)).css;
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style><div id="root"></div><script>${readFileSync(resolve(GEN, "bundle.js"), "utf8")}</script>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;

const browser = await playwright.chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page.on("pageerror", (error) => console.error(`BROWSER_PAGE_ERROR: ${error.message}`));
  await page.route("**/api/player-popularity", async (route) => {
    await new Promise((done) => setTimeout(done, 1500));
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ counts: { "50650": 999999, "52605": 888888 }, degraded: false }),
    });
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByTestId("player-popularity-loading").waitFor();
  await page.waitForTimeout(1250);

  const rows = page.locator('button.w-full.flex.items-center.gap-3');
  await rows.first().waitFor({ timeout: 5000 }).catch(async (error) => {
    throw new Error(`${error.message}\nbody=${(await page.locator("body").innerText()).slice(0, 1000)}`);
  });
  const before = await rows.evaluateAll((nodes) => nodes.slice(0, 3).map((node) => node.textContent));
  await rows.nth(1).tap();
  await page.locator("div.max-h-\\[45vh\\]").evaluate((node) => { node.scrollTop = 120; });
  await page.waitForTimeout(500);
  const after = await rows.evaluateAll((nodes) => nodes.slice(0, 3).map((node) => node.textContent));
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`late popularity response moved rows: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
  console.log(`PASS browser player popularity: delay=1500ms stable_rows=${before.length} touch_scroll=true`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  rmSync(GEN, { recursive: true, force: true });
}
