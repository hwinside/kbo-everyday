#!/usr/bin/env node
/** 피드·상세·댓글 공용 작성자 헤더 — 320/390px 실제 DOM 회귀. */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import playwright from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REQUIRE_BROWSER = process.env.POST_HEADER_REQUIRE_BROWSER === "1";
const chromiumPath = playwright.chromium.executablePath();
if (!chromiumPath || !existsSync(chromiumPath)) {
  console.log(`${REQUIRE_BROWSER ? "FAIL" : "SKIP"}: playwright chromium 사용 불가`);
  process.exit(REQUIRE_BROWSER ? 1 : 0);
}
const ROOT = process.cwd();
const GEN = mkdtempSync(resolve(tmpdir(), "community-author-header-"));
let source = readFileSync(resolve(ROOT, "src/components/community/CommunityAuthorHeader.tsx"), "utf8");
const row1 = 'className="flex min-w-0 items-center gap-1.5 whitespace-nowrap"';
const row2 = 'className="mt-1 flex min-w-0 items-center gap-1.5 whitespace-nowrap"';
const nick = 'className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-primary active:opacity-70"';
if (![row1, row2, nick].every((x) => source.includes(x))) {
  console.error("FAIL: 공용 헤더 계약 지점을 특정하지 못함"); process.exit(1);
}
if (process.env.POST_HEADER_MUTATE_ONELINE === "1") {
  source = source
    .replace('className="min-w-0 flex-1"', 'className="flex min-w-0 flex-1 items-center gap-1.5"')
    .replace(row1, 'className="contents"')
    .replace(row2, 'className="contents"');
}
if (process.env.POST_HEADER_MUTATE_TRUNCATE === "1") {
  source = source.replace(nick, 'className="shrink-0 whitespace-nowrap text-[15px] font-semibold text-text-primary active:opacity-70"');
}
writeFileSync(resolve(GEN, "CommunityAuthorHeader.tsx"), source);
const testNickname = process.env.POST_HEADER_MUTATE_TRUNCATE === "1"
  ? "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허"
  : "밀어도안타당겨도안박재현";
writeFileSync(resolve(GEN, "link.jsx"), `export default function Link({href,children,...p}){return <a href={href} {...p}>{children}</a>}`);
writeFileSync(resolve(GEN, "image.jsx"), `export default function Image(p){const{unoptimized,priority,...q}=p;return <img {...q}/>} `);
writeFileSync(resolve(GEN, "entry.jsx"), `
import React from "react"; import {createRoot} from "react-dom/client";
import {ThemeProvider} from "@/components/ThemeProvider";
import Header from "./CommunityAuthorHeader";
const N=${JSON.stringify(testNickname)};
function Item({kind}){const detail=kind==="detail";return <section data-kind={kind} className="w-full border-b border-border px-4 py-3"><Header nickname={N} teamId={1} avatarUrl={null} profileHref="/profile/qa" meta={<>{detail&&<button className="text-[10px]">쪽지</button>}<span className="text-[11px] text-text-tertiary">12시간 전</span>{detail&&<span className="text-[11px] text-text-tertiary">조회 120</span>}</>} menu={<button aria-label="더보기">•••</button>}/></section>}
function App(){return <ThemeProvider><main className="w-full bg-bg-primary"><Item kind="feed"/><Item kind="detail"/><Item kind="comment"/></main></ThemeProvider>};createRoot(document.getElementById("root")).render(<App/>);`);
await build({entryPoints:[resolve(GEN,"entry.jsx")],bundle:true,format:"iife",outfile:resolve(GEN,"bundle.js"),jsx:"automatic",absWorkingDir:ROOT,nodePaths:[resolve(ROOT,"node_modules")],tsconfig:resolve(ROOT,"tsconfig.json"),alias:{"next/link":resolve(GEN,"link.jsx"),"next/image":resolve(GEN,"image.jsx")},logLevel:"error"});
const globals=resolve(ROOT,"src/styles/globals.css");
const css=(await postcss([tailwind]).process(`@source "${resolve(GEN,"entry.jsx")}";\n@source "${resolve(GEN,"CommunityAuthorHeader.tsx")}";\n${readFileSync(globals,"utf8")}`,{from:globals})).css;
writeFileSync(resolve(GEN,"index.html"),`<meta name="viewport" content="width=device-width"><style>${css}body{margin:0}</style><div id="root"></div><script src="/bundle.js"></script>`);
const server=createServer((req,res)=>{const f=req.url==="/bundle.js"?"bundle.js":"index.html";res.setHeader("content-type",f.endsWith("js")?"text/javascript":"text/html");res.end(readFileSync(resolve(GEN,f)))});await new Promise(r=>server.listen(0,r));
let failures=0,total=0;const check=(n,ok,d="")=>{total++;console.log(`  ${ok?"✅":"❌"} ${n}${d?` — ${d}`:""}`);if(!ok)failures++};
const browser=await playwright.chromium.launch();
try{for(const width of [390,320]){console.log(`\n[${width}px]`);const page=await browser.newPage({viewport:{width,height:844},deviceScaleFactor:2});await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:"networkidle"});const probes=await page.locator("section").evaluateAll((els)=>els.map((section)=>{const avatar=section.querySelector("a > span");const info=avatar?.parentElement?.nextElementSibling;const r1=info?.children[0],r2=info?.children[1];const n=r1?.querySelector("a,span");const ar=avatar?.getBoundingClientRect(),a=r1?.getBoundingClientRect(),b=r2?.getBoundingClientRect();return{kind:section.dataset.kind,avatar:[Math.round(ar?.width||0),Math.round(ar?.height||0)],nick:[n?.clientWidth||0,n?.scrollWidth||0],rows:[Math.round(a?.bottom||0),Math.round(b?.top||0)],team:(r2?.textContent||"").includes("LG 팬"),overflow:section.scrollWidth>section.clientWidth}}));for(const p of probes){check(`${p.kind} 아바타 40px`,p.avatar[0]===40&&p.avatar[1]===40,`${p.avatar}`);check(`${p.kind} 아이디 미잘림`,p.nick[1]<=p.nick[0],`${p.nick[1]}/${p.nick[0]}`);check(`${p.kind} 1·2행 분리`,p.rows[1]>=p.rows[0],`${p.rows}`);check(`${p.kind} 2행 LG 팬 배지`,p.team);check(`${p.kind} 가로 overflow 없음`,!p.overflow)}}}
finally{await browser.close();server.close();rmSync(GEN,{recursive:true,force:true})}
console.log(failures?`\nFAIL ${failures}/${total}`:`\nPASS — ${total}/${total}`);process.exit(failures?1:0);
