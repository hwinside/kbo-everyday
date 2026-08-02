#!/usr/bin/env node
/**
 * 기존 장닉네임 사용자의 닉네임 변경 UX를 실제 Chromium에서 고정한다.
 *
 * - 기존 10자 값은 input의 maxLength=8 때문에 강제 절단되지 않는다.
 * - 기존값/9자 저장 시 2~8자 안내가 보이고 입력값은 보존된다.
 * - 8자로 수정하면 실제 fetch→onSaved→onClose 흐름을 탄다.
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import playwright from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REQUIRE_BROWSER = process.env.NICKNAME_EDIT_REQUIRE_BROWSER === "1";
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
const GEN = mkdtempSync(resolve(tmpdir(), "nickname-edit-sheet-"));
const CURRENT_NICKNAME = "가나다라마바사아자차";
const NINE_CHAR_NICKNAME = "가나다라마바사아자";
const EIGHT_CHAR_NICKNAME = "가나다라마바사아";

writeFileSync(resolve(GEN, "client.js"), `
export const supabase={auth:{getSession:async()=>({data:{session:{access_token:"qa-token"}}})}};`);
writeFileSync(resolve(GEN, "motion.jsx"), `
import React from "react";
const strip=({initial,animate,exit,transition,whileTap,whileHover,layout,variants,...rest})=>rest;
const make=(tag)=>React.forwardRef((props,ref)=>React.createElement(tag,{...strip(props),ref}));
export const motion=new Proxy({},{get:(_,tag)=>make(tag)});
export const AnimatePresence=({children})=>children;`);
writeFileSync(resolve(GEN, "entry.jsx"), `
import React from "react";
import {createRoot} from "react-dom/client";
import NicknameEditSheet from "@/components/profile/NicknameEditSheet";
window.__qa={fetches:[],saved:0,closed:0};
window.fetch=async(url,options)=>{
  window.__qa.fetches.push({url,body:options?.body||null});
  return {ok:true,json:async()=>({success:true})};
};
function App(){
  return <NicknameEditSheet
    isOpen={true}
    onClose={()=>{window.__qa.closed+=1}}
    currentNickname=${JSON.stringify(CURRENT_NICKNAME)}
    status={{nickname:${JSON.stringify(CURRENT_NICKNAME)},used:0,remaining:2,limit:2,windowDays:30,resetAt:null}}
    onSaved={async()=>{window.__qa.saved+=1}}
  />;
}
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
  banner: { js: 'globalThis.process=globalThis.process||{env:{NODE_ENV:"production"}};' },
  alias: {
    "@/lib/supabase/client": resolve(GEN, "client.js"),
    "framer-motion": resolve(GEN, "motion.jsx"),
  },
  logLevel: "error",
});

const GLOBALS = resolve(ROOT, "src/styles/globals.css");
const COMPONENT = resolve(ROOT, "src/components/profile/NicknameEditSheet.tsx");
const cssInput = `@source "${COMPONENT}";\n${readFileSync(GLOBALS, "utf8")}`;
const css = (await postcss([tailwind]).process(cssInput, { from: GLOBALS })).css;
writeFileSync(resolve(GEN, "index.html"), `<!doctype html><html lang="ko"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>${css}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`);

const server = createServer((req, res) => {
  const file = req.url === "/bundle.js" ? "bundle.js" : "index.html";
  res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : "text/html");
  res.end(readFileSync(resolve(GEN, file)));
});
await new Promise((done) => server.listen(0, done));
const port = server.address().port;

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const browser = await playwright.chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  const input = page.locator('input[type="text"]');
  const save = page.getByRole("button", { name: "변경하기" });
  const error = page.getByText("닉네임은 2~8자로 입력해주세요");

  await input.waitFor();
  check("기존 10자 닉네임이 강제 절단 없이 표시", await input.inputValue() === CURRENT_NICKNAME, await input.inputValue());
  check("기존값 확인을 위해 maxLength는 현재 10자까지 보존", await input.getAttribute("maxlength") === "10");
  check("2~8자 정책 안내 노출", await page.getByText("2~8자 · 한글, 영문, 숫자만 사용 가능").isVisible());

  await save.click();
  check("기존 장닉네임 재저장 시 명확한 오류 안내", await error.isVisible());
  check("오류 뒤 기존 장닉네임 값 보존", await input.inputValue() === CURRENT_NICKNAME, await input.inputValue());
  check("기존 장닉네임 오류는 API write 이전 차단", await page.evaluate(() => window.__qa.fetches.length) === 0);

  await input.fill(NINE_CHAR_NICKNAME);
  await save.click();
  check("9자 재요청 시 명확한 오류 안내", await error.isVisible());
  check("9자 오류 뒤 입력값 보존", await input.inputValue() === NINE_CHAR_NICKNAME, await input.inputValue());
  check("9자 오류는 API write 이전 차단", await page.evaluate(() => window.__qa.fetches.length) === 0);

  await input.fill(EIGHT_CHAR_NICKNAME);
  await save.click();
  await page.waitForFunction(() => window.__qa.saved === 1 && window.__qa.closed === 1);
  const qa = await page.evaluate(() => window.__qa);
  check("8자 수정값 API 저장 호출", qa.fetches.length === 1 && JSON.parse(qa.fetches[0].body).nickname === EIGHT_CHAR_NICKNAME);
  check("8자 저장 후 onSaved 호출", qa.saved === 1);
  check("8자 저장 후 시트 닫기 호출", qa.closed === 1);
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}

console.log(failures === 0 ? `\nPASS — ${checks}/${checks}` : `\nFAIL ${failures} / ${checks} · exit 1`);
process.exit(failures === 0 ? 0 : 1);
