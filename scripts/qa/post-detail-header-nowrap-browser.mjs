#!/usr/bin/env node
/** 공용 작성자 헤더 + 실제 PostCard 소비 경로 — 320/390px DOM 회귀. */
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
  console.error("FAIL: 공용 헤더 계약 지점을 특정하지 못함");
  process.exit(1);
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
const customAvatar = "custom:data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%23ef4444'/%3E%3C/svg%3E";
writeFileSync(resolve(GEN, "link.jsx"), `export default function Link({href,children,...p}){return <a href={href} {...p}>{children}</a>}`);
writeFileSync(resolve(GEN, "image.jsx"), `export default function Image(p){const{unoptimized,priority,...q}=p;return <img {...q}/>} `);
writeFileSync(resolve(GEN, "entry.jsx"), `
import React from "react";
import {createRoot} from "react-dom/client";
import {ThemeProvider} from "@/components/ThemeProvider";
import Header from "./CommunityAuthorHeader";
import PostCard from "@/components/community/PostCard";
const N=${JSON.stringify(testNickname)};
const POST={id:991,boardType:"player",boardId:"61102",authorId:"qa",title:"실제 PostCard",content:"작성자 응원팀과 글 소속이 다른 fixture",imageUrls:[],videoUrls:[],likeCount:3,commentCount:2,isReported:false,createdAt:new Date().toISOString(),author:{nickname:N,avatarUrl:${JSON.stringify(customAvatar)},myTeamId:2,level:1,title:""}};
function HeaderFixture({kind,avatarUrl}){return <section data-kind={kind} className="w-full border-b border-border px-4 py-3"><Header nickname={N} teamId={2} avatarUrl={avatarUrl} profileHref="/profile/qa" meta={<><span className="text-[11px] text-text-tertiary">12시간 전</span>{kind==="detail"&&<span className="text-[11px] text-text-tertiary">조회 120</span>}</>} menu={<button aria-label="더보기">•••</button>}/></section>}
function App(){return <ThemeProvider><main className="w-full bg-bg-primary"><section data-kind="feed" className="p-2"><PostCard post={POST} sourceLabel={{text:"LG 박해민/오스틴 외 1명",teamId:1,playerName:"박해민/오스틴 외 1명"}}/></section><HeaderFixture kind="detail" avatarUrl="preset:baseball"/><HeaderFixture kind="comment" avatarUrl={null}/></main></ThemeProvider>}
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
  alias: {
    "next/link": resolve(GEN, "link.jsx"),
    "next/image": resolve(GEN, "image.jsx"),
    "@/components/community/CommunityAuthorHeader": resolve(GEN, "CommunityAuthorHeader.tsx"),
  },
  logLevel: "error",
});
const globals = resolve(ROOT, "src/styles/globals.css");
const css = (await postcss([tailwind]).process(
  `@source "${resolve(GEN, "entry.jsx")}";\n@source "${resolve(GEN, "CommunityAuthorHeader.tsx")}";\n@source "${resolve(ROOT, "src/components/community/PostCard.tsx")}";\n${readFileSync(globals, "utf8")}`,
  { from: globals },
)).css;
writeFileSync(resolve(GEN, "index.html"), `<meta name="viewport" content="width=device-width"><style>${css}body{margin:0}</style><div id="root"></div><script src="/bundle.js"></script>`);
const server = createServer((req, res) => {
  const f = req.url === "/bundle.js" ? "bundle.js" : "index.html";
  res.setHeader("content-type", f.endsWith("js") ? "text/javascript" : "text/html");
  res.end(readFileSync(resolve(GEN, f)));
});
await new Promise((r) => server.listen(0, r));

let failures = 0;
let total = 0;
const check = (name, ok, detail = "") => {
  total += 1;
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const browser = await playwright.chromium.launch();
try {
  for (const width of [390, 320]) {
    console.log(`\n[${width}px]`);
    const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
    const probes = await page.locator("section[data-kind]").evaluateAll((sections) => sections.map((section) => {
      const header = section.querySelector("[data-community-author-header]");
      const avatar = header?.firstElementChild;
      const info = avatar?.nextElementSibling;
      const rowOne = info?.children[0];
      const rowTwo = info?.children[1];
      const nickname = rowOne?.querySelector("a,span");
      const avatarRect = avatar?.getBoundingClientRect();
      const firstRect = rowOne?.getBoundingClientRect();
      const secondRect = rowTwo?.getBoundingClientRect();
      return {
        kind: section.dataset.kind,
        avatar: [Math.round(avatarRect?.width || 0), Math.round(avatarRect?.height || 0)],
        hasImage: !!avatar?.querySelector("img"),
        nickname: [nickname?.clientWidth || 0, nickname?.scrollWidth || 0],
        rows: [Math.round(firstRect?.bottom || 0), Math.round(secondRect?.top || 0)],
        authorTeam: (rowTwo?.textContent || "").includes("두산 팬"),
        sourceTeam: (section.textContent || "").includes("LG 박해민/오스틴 외 1명"),
        sourceLabel: (section.textContent || "").includes("글 소속"),
        overflow: section.scrollWidth > section.clientWidth,
      };
    }));
    for (const probe of probes) {
      check(`${probe.kind} 아바타 40px`, probe.avatar[0] === 40 && probe.avatar[1] === 40, `${probe.avatar}`);
      check(`${probe.kind} 아이디 미잘림`, probe.nickname[1] <= probe.nickname[0], `${probe.nickname[1]}/${probe.nickname[0]}`);
      check(`${probe.kind} 1·2행 분리`, probe.rows[1] >= probe.rows[0], `${probe.rows}`);
      check(`${probe.kind} 작성자팀 두산 팬`, probe.authorTeam);
      check(`${probe.kind} 가로 overflow 없음`, !probe.overflow);
    }
    const byKind = Object.fromEntries(probes.map((p) => [p.kind, p]));
    check("실제 PostCard custom avatar", byKind.feed?.hasImage === true);
    check("preset avatar", byKind.detail?.hasImage === true);
    check("null avatar fallback", byKind.comment?.hasImage === false);
    check("작성자팀≠글소속 분리", byKind.feed?.authorTeam && byKind.feed?.sourceLabel && byKind.feed?.sourceTeam);
    check("댓글 글소속 미노출", !byKind.comment?.sourceLabel);
  }
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}
console.log(failures ? `\nFAIL ${failures}/${total}` : `\nPASS — ${total}/${total}`);
process.exit(failures ? 1 : 0);
