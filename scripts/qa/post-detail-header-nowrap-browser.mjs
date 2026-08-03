#!/usr/bin/env node
/**
 * 게시글 상세 작성자 헤더 — 390px 실제 DOM 렌더 회귀.
 *
 * 소스 문자열 검사가 아니라 실제 브라우저 레이아웃을 assert 한다.
 * (삼순 NO-GO 2026-08-02: 바깥 flex 를 제거해도 문자열 스모크가 통과했음)
 *
 * 결함주입(mutation) 환경변수 — 각각 RED 여야 한다:
 *   POST_HEADER_MUTATE_FLEX=1        바깥 헤더 flex 제거
 *   POST_HEADER_MUTATE_NOWRAP=1      whitespace-nowrap 제거
 *   POST_HEADER_MUTATE_TRUNCATE=1    닉네임 truncate/min-w-0 제거
 *   POST_HEADER_MUTATE_SHRINK=1      우측 항목 shrink-0 제거
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import playwright from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REQUIRE_BROWSER = process.env.POST_HEADER_REQUIRE_BROWSER === "1";
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
const GEN = mkdtempSync(resolve(tmpdir(), "post-header-"));

/* ------------------------------------------------------------------ *
 * 1) 대상 컴포넌트 소스 + 결함주입
 * ------------------------------------------------------------------ */
const DETAIL_PATH = resolve(ROOT, "src/components/community/PostDetail.tsx");
let detailSource = readFileSync(DETAIL_PATH, "utf8");

const HEADER_OPEN = '<div className="flex items-center gap-2 mb-3 whitespace-nowrap">';
if (detailSource.split(HEADER_OPEN).length - 1 !== 1) {
  console.error("FAIL: 작성자 헤더 컨테이너를 특정하지 못함(문구 변경 시 이 스모크를 함께 갱신할 것)");
  process.exit(1);
}

const NICKNAME_CLASS = 'className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary cursor-pointer hover:text-accent"';
if (detailSource.split(NICKNAME_CLASS).length - 1 !== 1) {
  console.error("FAIL: 닉네임 span 클래스를 특정하지 못함");
  process.exit(1);
}

const mutations = [];
if (process.env.POST_HEADER_MUTATE_FLEX === "1") {
  detailSource = detailSource.replace(HEADER_OPEN, '<div className="items-center gap-2 mb-3 whitespace-nowrap">');
  mutations.push("flex 제거");
}
if (process.env.POST_HEADER_MUTATE_NOWRAP === "1") {
  detailSource = detailSource.replace(HEADER_OPEN, '<div className="flex items-center gap-2 mb-3">');
  mutations.push("whitespace-nowrap 제거");
}
if (process.env.POST_HEADER_MUTATE_TRUNCATE === "1") {
  detailSource = detailSource.replace(
    NICKNAME_CLASS,
    'className="text-[13px] font-semibold text-text-primary cursor-pointer hover:text-accent"',
  );
  mutations.push("닉네임 truncate/min-w-0 제거");
}
if (process.env.POST_HEADER_MUTATE_SHRINK === "1") {
  detailSource = detailSource.replaceAll('className="shrink-0"', 'className=""');
  detailSource = detailSource.replace('className="shrink-0 text-sm text-text-tertiary"', 'className="text-sm text-text-tertiary"');
  detailSource = detailSource.replace('<div className="shrink-0">\n            <PostActionsMenu', '<div>\n            <PostActionsMenu');
  mutations.push("shrink-0 제거");
}

const detailEntry = resolve(GEN, "PostDetail-under-test.tsx");
writeFileSync(detailEntry, detailSource);

/* ------------------------------------------------------------------ *
 * 2) 외부 의존 스텁 — 헤더 레이아웃과 무관한 네트워크/네이티브만 대체
 *    (헤더를 구성하는 TeamBadge/DMButton/PostViewBadge/PostActionsMenu 는 실물 사용)
 * ------------------------------------------------------------------ */
const LONG_NICKNAME = process.env.POST_HEADER_NICKNAME ?? "가나다라마바사아자차카타";
// 운영팀 배지까지 붙으면 행이 더 빡빡해져 shrink-0 가 실제로 일을 한다.
const SCENARIOS = [
  { name: "일반 작성자", grade: "user" },
  { name: "운영팀 배지 동반", grade: "staff" },
];

writeFileSync(resolve(GEN, "auth.jsx"), `
const AUTH={
  user:{id:"viewer-qa",email:"post-header-qa@example.invalid"},
  profile:{nickname:"뷰어",team_id:1,avatar_url:null,grade:"user"},
  loading:false,
  refreshProfile:async()=>{},
  signOut:async()=>{}
};
export const useAuth=()=>AUTH;`);

writeFileSync(resolve(GEN, "usePosts.js"), `
import {useState} from "react";
const NICKNAME=${JSON.stringify(LONG_NICKNAME)};
const POST={
  id:3832,
  author_id:"author-qa",
  board_type:"free",
  board_id:"free",
  content_type:"general",
  title:"작성자 헤더 한 줄 회귀",
  content:"본문",
  image_urls:[],
  video_urls:[],
  like_count:0,
  comment_count:0,
  created_at:new Date(Date.now()-3600*1000).toISOString(),
  updated_at:null,
  click_view_count:12345,
  impression_view_count:6789,
  nickname:NICKNAME,
  team_id:1,
  grade:new URLSearchParams(window.location.search).get("grade")||"user"
};
export function usePostDetail(){
  const [post]=useState(POST);
  const [comments,setComments]=useState([]);
  const [liked,setLiked]=useState(false);
  return {post,comments,loading:false,liked,setLiked,setComments};
}
export const createComment=async()=>{};
export const toggleLike=async()=>{};
export const toggleCommentLike=async()=>{};
export const updatePost=async()=>{};
export const deletePost=async()=>{};
export const updateComment=async()=>{};
export const deleteComment=async()=>{};
export const uploadCommentImage=async()=>"";`);

writeFileSync(resolve(GEN, "client.js"), `
export const supabase={auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:null}})}};
export async function getSafeSession(){return null;}`);
writeFileSync(resolve(GEN, "useBlock.js"), `
export const useBlockedIds=()=>({blockedIds:new Set(),refresh:async()=>{}});
export const blockUserById=async()=>{};`);
writeFileSync(resolve(GEN, "useDM.js"), `
export const getExistingConversation=async()=>null;`);
writeFileSync(resolve(GEN, "view-tracker.js"), `
export const trackPostClick=()=>{};
export const currentViewerKey=()=>"qa";`);
writeFileSync(resolve(GEN, "navigation.js"), `
export const useRouter=()=>({push:()=>{},replace:()=>{},back:()=>{}});
export const usePathname=()=>"/community/free/3832";
export const useSearchParams=()=>new URLSearchParams();`);
writeFileSync(resolve(GEN, "image.jsx"), `
export default function Image(p){const{fill,priority,unoptimized,...rest}=p;return <img {...rest}/>;}`);
writeFileSync(resolve(GEN, "link.jsx"), `
export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>;}`);
writeFileSync(resolve(GEN, "motion.jsx"), `
import React from "react";
const strip=({initial,animate,exit,transition,whileTap,whileHover,layout,variants,...rest})=>rest;
const make=(tag)=>React.forwardRef((props,ref)=>React.createElement(tag,{...strip(props),ref}));
export const motion=new Proxy({},{get:(_,tag)=>make(tag)});
export const AnimatePresence=({children})=>children;`);
writeFileSync(resolve(GEN, "empty.jsx"), `
export default function Empty(){return null;}`);
writeFileSync(resolve(GEN, "entry.jsx"), `
import React from "react";
import {createRoot} from "react-dom/client";
import {ThemeProvider} from "@/components/ThemeProvider";
import PostDetail from "./PostDetail-under-test";
createRoot(document.getElementById("root")).render(<ThemeProvider><PostDetail postId={3832}/></ThemeProvider>);`);

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
    "@/lib/supabase/AuthContext": resolve(GEN, "auth.jsx"),
    "@/lib/supabase/usePosts": resolve(GEN, "usePosts.js"),
    "@/lib/supabase/client": resolve(GEN, "client.js"),
    "@/lib/supabase/useBlock": resolve(GEN, "useBlock.js"),
    "@/lib/supabase/useDM": resolve(GEN, "useDM.js"),
    "@/lib/community/view-tracker": resolve(GEN, "view-tracker.js"),
    "@/components/auth/LoginSheet": resolve(GEN, "empty.jsx"),
    "@/components/community/GifPicker": resolve(GEN, "empty.jsx"),
    "@/components/community/ReportSheet": resolve(GEN, "empty.jsx"),
    "@/components/community/ShareSheet": resolve(GEN, "empty.jsx"),
    "@/components/community/CommentImageLightbox": resolve(GEN, "empty.jsx"),
    "next/image": resolve(GEN, "image.jsx"),
    "next/link": resolve(GEN, "link.jsx"),
    "next/navigation": resolve(GEN, "navigation.js"),
    "framer-motion": resolve(GEN, "motion.jsx"),
  },
  logLevel: "error",
});

/* ------------------------------------------------------------------ *
 * 3) Tailwind CSS — 실제 클래스가 실제 레이아웃을 만들어야 의미가 있다
 * ------------------------------------------------------------------ */
const GLOBALS = resolve(ROOT, "src/styles/globals.css");
const cssInput = `@source "${detailEntry}";\n${readFileSync(GLOBALS, "utf8")}`;
const css = (await postcss([tailwind]).process(cssInput, { from: GLOBALS })).css;

writeFileSync(resolve(GEN, "index.html"), `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>${css}</style>
<style>body{margin:0}</style>
</head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`);

const server = createServer((req, res) => {
  const file = req.url === "/bundle.js" ? "bundle.js" : "index.html";
  res.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : "text/html" });
  res.end(readFileSync(resolve(GEN, file)));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

/* ------------------------------------------------------------------ *
 * 4) 실제 DOM assert
 * ------------------------------------------------------------------ */
let failures = 0;
let total = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const browser = await playwright.chromium.launch();
try {
 for (const scenario of SCENARIOS) {
  console.log(`\n[${scenario.name}]`);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page.on("console", (m) => { if (m.type() === "error") console.log(`[console] ${m.text()}`); });
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/?grade=${scenario.grade}`, { waitUntil: "networkidle" });
  try {
    await page.waitForSelector("text=작성자 헤더 한 줄 회귀", { timeout: 15000 });
  } catch (err) {
    console.log("[dom]", (await page.content()).slice(0, 1500));
    throw err;
  }

  const probe = await page.evaluate((nickname) => {
    const nick = Array.from(document.querySelectorAll("span")).find((el) => el.textContent === nickname);
    if (!nick) return { error: "닉네임 요소를 찾지 못함" };
    const header = nick.parentElement;
    const hr = header.getBoundingClientRect();
    // items-center 정렬이라 항목마다 높이가 달라 top 은 원래 다르다.
    // "한 행"의 올바른 판정은 세로 구간이 서로 겹치는지(교집합 존재)다.
    const children = Array.from(header.children).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        text: (el.textContent || "").slice(0, 12),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        centerY: Math.round(r.top + r.height / 2),
        width: Math.round(r.width),
      };
    });
    const nickRect = nick.getBoundingClientRect();
    const body = document.body.getBoundingClientRect();
    return {
      headerTop: Math.round(hr.top),
      headerHeight: Math.round(hr.height),
      headerClientWidth: header.clientWidth,
      headerScrollWidth: header.scrollWidth,
      headerDisplay: getComputedStyle(header).display,
      children,
      nick: {
        clientWidth: nick.clientWidth,
        scrollWidth: nick.scrollWidth,
        height: Math.round(nickRect.height),
        overflow: getComputedStyle(nick).textOverflow,
      },
      texts: {
        dm: Boolean(Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").includes("쪽지"))),
        time: Boolean(Array.from(document.querySelectorAll("span")).find((s) => /(분|시간|일) 전/.test(s.textContent || ""))),
        views: Boolean(Array.from(document.querySelectorAll("span")).find((s) => (s.getAttribute("title") || "") === "조회수")),
        menu: document.querySelectorAll("svg.lucide-ellipsis, svg.lucide-more-horizontal").length > 0,
      },
      bodyScrollWidth: Math.round(document.documentElement.scrollWidth),
      bodyClientWidth: Math.round(body.width),
    };
  }, LONG_NICKNAME);

  if (probe.error) {
    console.error(`FAIL: ${probe.error}`);
    process.exit(1);
  }

  // 모든 항목의 세로 구간이 공통 y 를 공유하면 한 행이다(줄바뜼면 구간이 분리된다).
  const overlapTop = Math.max(...probe.children.map((c) => c.top));
  const overlapBottom = Math.min(...probe.children.map((c) => c.bottom));
  check(
    "작성자 헤더의 모든 항목이 한 행",
    probe.children.length > 1 && overlapBottom > overlapTop,
    `공통 세로구간 [${overlapTop}, ${overlapBottom}] / 항목 ${probe.children.length}개`,
  );
  check(
    "헤더가 가로로 넘치지 않음(scrollWidth === clientWidth)",
    probe.headerScrollWidth === probe.headerClientWidth,
    `scrollWidth=${probe.headerScrollWidth} clientWidth=${probe.headerClientWidth}`,
  );
  check(
    "헤더 높이가 한 줄(≤34px)",
    probe.headerHeight > 0 && probe.headerHeight <= 34,
    `height=${probe.headerHeight}`,
  );
  check(
    "긴 닉네임만 말줄임(scrollWidth > clientWidth)",
    probe.nick.scrollWidth > probe.nick.clientWidth && probe.nick.overflow === "ellipsis",
    `nick clientWidth=${probe.nick.clientWidth} scrollWidth=${probe.nick.scrollWidth} textOverflow=${probe.nick.overflow}`,
  );
  check("쪽지 버튼 노출 유지", probe.texts.dm);
  check("작성 시간 노출 유지", probe.texts.time);
  check("조회수 노출 유지", probe.texts.views);
  check("더보기 메뉴 노출 유지", probe.texts.menu);
  check(
    "페이지 가로 스크롤 없음",
    probe.bodyScrollWidth <= 390,
    `documentScrollWidth=${probe.bodyScrollWidth}`,
  );

  await page.close();
  total += 9;
 }
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}

if (mutations.length) {
  console.log(`\n[mutation] ${mutations.join(", ")}`);
}
console.log(failures === 0 ? `\nPASS — ${total}/${total}` : `\nFAIL ${failures} / exit 1`);
process.exit(failures === 0 ? 0 : 1);
