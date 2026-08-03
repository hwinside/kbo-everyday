#!/usr/bin/env node
/** 실제 커뮤니티 작성자 소비자 — 320/390px DOM·의미·상호작용 회귀. */
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
const GEN = mkdtempSync(resolve(tmpdir(), "community-author-consumers-"));
const copy = (from, to, mutate = (source) => source) => {
  writeFileSync(resolve(GEN, to), mutate(readFileSync(resolve(ROOT, from), "utf8")));
};

copy("src/components/community/CommunityAuthorHeader.tsx", "CommunityAuthorHeader.tsx", (source) => {
  if (process.env.POST_HEADER_MUTATE_PROPAGATION === "1") {
    source = source.replaceAll(" onClick={stopCardNavigation}", "");
  }
  if (process.env.POST_HEADER_MUTATE_DETAIL_WRAP === "1") {
    source = source.replace("flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1", "flex min-w-0 items-center gap-1.5 whitespace-nowrap");
  }
  return source;
});
copy("src/components/community/CommunityCommentRow.tsx", "CommunityCommentRow.tsx", (source) =>
  process.env.POST_HEADER_MUTATE_COMMENT_INDENT === "1"
    ? source.replace('className="ml-[50px] min-w-0"', 'className="ml-0 min-w-0"')
    : source,
);
copy("src/components/profile/CommunityProfilePostRow.tsx", "CommunityProfilePostRow.tsx", (source) =>
  process.env.POST_HEADER_MUTATE_PROFILE_SOURCE === "1"
    ? source.replace("const sourceLabel = getPostSourceLabel(post);", 'const sourceLabel = { text: "자유게시판" };')
    : source,
);
copy("src/lib/constants/avatars.ts", "avatars.ts", (source) =>
  process.env.POST_HEADER_MUTATE_RAW_AVATAR === "1"
    ? source.replace(/\n  if \(avatarUrl\.startsWith\("\/"\) \|\| avatarUrl\.startsWith\("https:\/\/"\)\) \{\n    return avatarUrl;\n  \}/, "")
    : source,
);

writeFileSync(resolve(GEN, "link.jsx"), `
export default function Link({href,children,onClick,...props}) {
  return <a href={href} onClick={(event) => { event.preventDefault(); onClick?.(event); }} {...props}>{children}</a>;
}`);
writeFileSync(resolve(GEN, "navigation.jsx"), `export function useRouter(){return {push(){},back(){},replace(){}}} export function usePathname(){return "/"}`);
writeFileSync(resolve(GEN, "auth.jsx"), `export function useAuth(){return {user:{id:"viewer"},profile:null,loading:false}}`);
writeFileSync(resolve(GEN, "dm.jsx"), `export async function getExistingConversation(){return null}`);
writeFileSync(resolve(GEN, "supabase.jsx"), `export const supabase={from(){throw new Error("unexpected supabase call")},storage:{from(){throw new Error("unexpected storage call")}}}`);
writeFileSync(resolve(GEN, "auth-actions.jsx"), `export async function signInWithApple(){} export async function signInWithGoogle(){} export async function signInWithKakao(){} export async function signInWithNaver(){}`);
writeFileSync(resolve(GEN, "image.jsx"), `export default function Image(props){const{unoptimized,priority,...rest}=props;return <img {...rest}/>} `);

const testNickname = "밀어도안타당겨도안박재현";
writeFileSync(resolve(GEN, "entry.jsx"), `
import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {ThemeProvider} from "@/components/ThemeProvider";
import PostCard from "@/components/community/PostCard";
import Header from "./CommunityAuthorHeader";
import CommentRow from "./CommunityCommentRow";
import ProfileRow from "./CommunityProfilePostRow";
import PostDetailAuthorHeader from "@/components/community/PostDetailAuthorHeader";
import {getPostSourceLabel} from "@/lib/utils/community-board";
const N=${JSON.stringify(testNickname)};
const SOURCE={board_type:"free",board_id:"free",team_tags:["lg"],player_tags:["62415:박해민","53123:오스틴","69102:문보경"]};
const LABEL=getPostSourceLabel(SOURCE);
const BASE={id:991,boardType:"free",boardId:"free",authorId:"author",title:"실제 PostCard",content:"작성자 응원팀과 글 소속이 다른 fixture",imageUrls:[],videoUrls:[],likeCount:3,commentCount:2,isReported:false,createdAt:new Date().toISOString(),author:{nickname:N,avatarUrl:"/test-avatar.svg",myTeamId:2,grade:"staff",level:1,title:""}};
function Menu(){return <button className="p-1" aria-label="더보기">•••</button>}
function CommentFixture({kind,isReply=false,avatarUrl}){return <section data-kind={kind} className="px-5 py-3"><CommentRow kind={kind==="detail-comment"?"detail":"sheet"} isReply={isReply} header={<Header nickname={N} teamId={2} avatarUrl={avatarUrl} profileHref="/profile/author" isStaff menu={<Menu/>} meta={<span className="shrink-0 text-xs text-text-tertiary">12시간 전 · 수정됨</span>}/>}><p className="mt-1 text-sm text-text-primary">실제 댓글 본문 정렬</p></CommentRow></section>}
function App(){const[presses,setPresses]=useState(0);return <ThemeProvider><main className="w-full bg-bg-primary">
  <section data-kind="feed" className="mx-5 py-2"><PostCard post={BASE} sourceLabel={LABEL} onPress={()=>setPresses((n)=>n+1)}/><output data-parent-press>{presses}</output></section>
  <section data-kind="poll" className="mx-5 py-2"><PostCard post={{...BASE,id:992,boardType:"poll",title:"투표 질문"}} sourceLabel={LABEL}/></section>
  <section data-kind="dedicated" className="mx-5 py-2"><PostCard post={{...BASE,id:993}}/></section>
  <section data-kind="detail" className="px-5 py-4"><PostDetailAuthorHeader nickname={N} teamId={2} avatarUrl="preset:baseball" authorId="author" viewerId="viewer" isStaff timeLabel="12시간 전" isEdited clickCount={1234} impressionCount={5} menu={<Menu/>}/></section>
  <CommentFixture kind="detail-comment" avatarUrl="/broken-avatar.svg"/>
  <CommentFixture kind="sheet-comment" isReply avatarUrl={null}/>
  <section data-kind="profile" className="mx-5 py-3"><ProfileRow post={{id:9,title:"프로필 글",board_type:"free",board_id:"free",like_count:1,comment_count:2,created_at:new Date().toISOString(),team_tags:SOURCE.team_tags,player_tags:SOURCE.player_tags}} timeLabel="오늘" onClick={()=>{}}/></section>
</main></ThemeProvider>}
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
  define: { "process.env": "{}" },
  alias: {
    "next/link": resolve(GEN, "link.jsx"),
    "next/navigation": resolve(GEN, "navigation.jsx"),
    "next/image": resolve(GEN, "image.jsx"),
    "@/lib/supabase/AuthContext": resolve(GEN, "auth.jsx"),
    "@/lib/supabase/useDM": resolve(GEN, "dm.jsx"),
    "@/lib/supabase/client": resolve(GEN, "supabase.jsx"),
    "@/lib/supabase/auth": resolve(GEN, "auth-actions.jsx"),
    "@/lib/constants/avatars": resolve(GEN, "avatars.ts"),
    "@/components/community/CommunityAuthorHeader": resolve(GEN, "CommunityAuthorHeader.tsx"),
    "@/components/community/CommunityCommentRow": resolve(GEN, "CommunityCommentRow.tsx"),
    "@/components/profile/CommunityProfilePostRow": resolve(GEN, "CommunityProfilePostRow.tsx"),
  },
  logLevel: "error",
});

const globals = resolve(ROOT, "src/styles/globals.css");
const cssSources = [
  resolve(GEN, "entry.jsx"),
  resolve(GEN, "CommunityAuthorHeader.tsx"),
  resolve(GEN, "CommunityCommentRow.tsx"),
  resolve(GEN, "CommunityProfilePostRow.tsx"),
  resolve(ROOT, "src/components/community/PostCard.tsx"),
  resolve(ROOT, "src/components/community/PostDetailAuthorHeader.tsx"),
  resolve(ROOT, "src/components/ui/DMButton.tsx"),
  resolve(ROOT, "src/components/community/PostViewBadge.tsx"),
].map((path) => `@source "${path}";`).join("\n");
const css = (await postcss([tailwind]).process(`${cssSources}\n${readFileSync(globals, "utf8")}`, { from: globals })).css;
writeFileSync(resolve(GEN, "index.html"), `<meta name="viewport" content="width=device-width"><style>${css}body{margin:0}</style><div id="root"></div><script src="/bundle.js"></script>`);
const avatarSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#ef4444"/></svg>`;
const server = createServer((req, res) => {
  if (req.url === "/bundle.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(resolve(GEN, "bundle.js"))); return; }
  if (req.url === "/test-avatar.svg" || req.url?.startsWith("/avatars/")) { res.setHeader("content-type", "image/svg+xml"); res.end(avatarSvg); return; }
  if (req.url === "/broken-avatar.svg") { res.statusCode = 404; res.end(); return; }
  res.setHeader("content-type", "text/html"); res.end(readFileSync(resolve(GEN, "index.html")));
});
await new Promise((done) => server.listen(0, done));

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
    const page = await browser.newPage({ viewport: { width, height: 1200 }, deviceScaleFactor: 2 });
    page.on("pageerror", (error) => console.error(`PAGE ERROR: ${error.message}`));
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
    await page.locator('[data-kind="feed"] [aria-label$="프로필 보기"]').first().click();
    check("PostCard 프로필 탭 부모 이동 차단", await page.locator("[data-parent-press]").textContent() === "0");

    for (const kind of ["feed", "poll", "dedicated", "detail", "detail-comment", "sheet-comment"]) {
      const section = page.locator(`[data-kind="${kind}"]`);
      const probe = await section.evaluate((node) => {
        const header = node.querySelector("[data-community-author-header]");
        const info = header?.children[1];
        const row1 = info?.children[0];
        const nickname = row1?.querySelector("a,span");
        const avatar = header?.children[0];
        const body = node.querySelector("[data-community-comment-body]");
        return {
          overflow: node.scrollWidth > node.clientWidth,
          nickname: [nickname?.scrollWidth ?? 0, nickname?.clientWidth ?? 0],
          avatar: [Math.round(avatar?.getBoundingClientRect().width ?? 0), Math.round(avatar?.getBoundingClientRect().height ?? 0)],
          hasImage: !!avatar?.querySelector("img"),
          staffInRow1: (row1?.textContent ?? "").includes("운영팀"),
          bodyMargin: body ? Math.round(Number.parseFloat(getComputedStyle(body).marginLeft)) : null,
          source: (node.querySelector("[data-community-source-label]")?.textContent ?? "").replace(/\s+/g, " "),
          hasSourceLabel: !!node.querySelector("[data-community-source-label]"),
        };
      });
      check(`${kind} 가로 overflow 없음`, !probe.overflow);
      if (kind !== "profile") {
        check(`${kind} 12자 아이디 미잘림`, probe.nickname[0] <= probe.nickname[1], `${probe.nickname[0]}/${probe.nickname[1]}`);
        check(`${kind} 아바타 40px`, probe.avatar[0] === 40 && probe.avatar[1] === 40, `${probe.avatar}`);
        check(`${kind} 운영팀은 2행`, !probe.staffInRow1);
      }
      if (kind.endsWith("comment")) check(`${kind} 본문 50px 정렬`, probe.bodyMargin === 50, `${probe.bodyMargin}`);
      if (kind === "feed" || kind === "poll") check(`${kind} 글 소속 3명`, /LG.*박해민\/오스틴 외 1명/.test(probe.source), probe.source);
      if (kind === "dedicated" || kind.endsWith("comment")) check(`${kind} 글 소속 미노출`, !probe.hasSourceLabel);
      if (kind === "feed") check("raw 시스템 아바타 이미지", probe.hasImage);
      if (kind === "detail-comment") check("이미지 로드 실패 이니셜 fallback", !probe.hasImage);
    }

    const profile = await page.locator('[data-kind="profile"]').evaluate((node) => ({
      overflow: node.scrollWidth > node.clientWidth,
      source: (node.querySelector("[data-community-source-label]")?.textContent ?? "").replace(/\s+/g, " "),
    }));
    check("profile 가로 overflow 없음", !profile.overflow);
    check("profile 태그 기반 글 소속 3명", /LG.*박해민\/오스틴 외 1명/.test(profile.source), profile.source);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}
console.log(failures ? `\nFAIL ${failures}/${total}` : `\nPASS — ${total}/${total}`);
process.exit(failures ? 1 : 0);
