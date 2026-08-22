#!/usr/bin/env node
/**
 * 프로필 작성글 목록 회귀 게이트 — 페이징 도달성 + 사진글 썸네일.
 *
 * 2026-08-22 하린아빠 #cs 제보 2건:
 *   ① "최근 글만 보이고 예전 글이 안 보인다" — `.limit(20)` 하드코딩 + 더보기 부재라
 *      21번째 글부터 **어떤 경로로도 도달 불가**였다(프로덕션 실측: 20건 초과 작성자 30명).
 *   ② "사진글은 제목 대신 썸네일" — 사진글은 `title: ""` 로 저장돼(1,424건 중 478건)
 *      제목만 그리던 행은 본문 줄이 통째로 비어 보였다.
 *
 * false-green 방지 설계(compound/lessons `verifier_must_read_real_artifact`):
 *   - 페이징은 **실제 소스의 순수 함수**(profile-posts-page.ts)를 import 해서 태운다.
 *     stub 재구현이면 그 재구현의 결함을 못 본다.
 *   - 렌더는 **실제 CommunityProfilePostRow** 를 esbuild 로 번들해 Chromium 에 마운트한다.
 *     판정은 클래스 문자열이 아니라 실제 DOM 노드(`[data-profile-post-thumbnail]`)로 한다.
 *   - 도달성은 "21번째 글이 화면에 실제로 있다"를 **글 제목 exact 문자열**로 확인한다.
 *     개수 비교만 하면 같은 페이지를 두 번 이어붙여도 통과한다.
 *   - mutation 5종으로 RED 를 실증한다. mutation 없이 통과만 보는 게이트는 아무것도 증명 못 한다.
 *
 * 실행: node scripts/qa/profile-posts-paging-gate.mjs
 *   mutation: PROFILE_POSTS_MUTATE=<name> node scripts/qa/profile-posts-paging-gate.mjs
 *   전 mutation 일괄 RED 검증: node scripts/qa/profile-posts-paging-gate.mjs --mutations
 */
import { build } from "esbuild";
import playwright from "playwright";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  PROFILE_POSTS_PAGE_SIZE,
  nextProfilePostsPage,
  profilePostsRange,
  splitProfilePostsPage,
} from "../../src/lib/utils/profile-posts-page.ts";

const ROOT = process.cwd();
const MUTATE = process.env.PROFILE_POSTS_MUTATE ?? "";
const REQUIRE_BROWSER = process.env.PROFILE_POSTS_REQUIRE_BROWSER === "1";

const ROW_PATH = resolve(ROOT, "src/components/profile/CommunityProfilePostRow.tsx");
const PAGE_PATH = resolve(ROOT, "src/app/(main)/profile/[userId]/page.tsx");
const PURE_PATH = resolve(ROOT, "src/lib/utils/profile-posts-page.ts");

/** mutation 이름 → [대상 파일, 원본 패턴, 변조] */
const MUTATIONS = {
  // ① 페이징 산식: 초과 1건을 안 받으면 hasMore 가 영영 false → 더보기 버튼이 안 뜬다(= 회귀 원복).
  "range-no-lookahead": [PURE_PATH, "return { from, to: from + PROFILE_POSTS_PAGE_SIZE };", "return { from, to: from + PROFILE_POSTS_PAGE_SIZE - 1 };"],
  // ② hasMore 를 항상 false 로 → 21번째 도달 불가(원래 버그 그대로).
  "hasmore-always-false": [PURE_PATH, "const hasMore = rows.length > PROFILE_POSTS_PAGE_SIZE;", "const hasMore = false;"],
  // ③ 다음 페이지 번호를 항상 0 으로 → 더보기 눌러도 1페이지만 반복(중복 append).
  "next-page-stuck": [PURE_PATH, "return Math.floor(loadedCount / PROFILE_POSTS_PAGE_SIZE);", "return 0;"],
  // ④ 썸네일 제거 → 사진글이 다시 빈 줄로 보인다.
  "thumbnail-removed": [ROW_PATH, "const thumbnail = profilePostThumbnailUrl(post);", "const thumbnail = null;"],
  // ⑤ 빈 image_urls 를 걸러내지 않음 → photo 인데 이미지 없는 글에 깨진 상자가 뜬다.
  "thumbnail-blank-passthrough": [ROW_PATH, 'const first = post.image_urls?.find(url => typeof url === "string" && url.trim().length > 0);', "const first = post.image_urls?.[0];"],
};

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok" : "FAIL"} - ${msg}`);
  if (!cond) failures += 1;
};

// ── --mutations: 각 mutation 이 실제로 RED 를 내는지 서브프로세스로 증명 ──────────
if (process.argv.includes("--mutations")) {
  const names = Object.keys(MUTATIONS);
  let bad = 0;
  // 먼저 baseline 이 GREEN 인지 확인 — baseline 이 RED 면 mutation RED 는 의미가 없다.
  const base = spawnSync(process.execPath, [resolve(ROOT, "scripts/qa/profile-posts-paging-gate.mjs")], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILE_POSTS_MUTATE: "", PROFILE_POSTS_REQUIRE_BROWSER: "1" },
  });
  console.log(`[baseline] exit=${base.status} (기대 0)`);
  if (base.status !== 0) { console.log(base.stdout?.slice(-2000) ?? ""); bad += 1; }
  for (const name of names) {
    const r = spawnSync(process.execPath, [resolve(ROOT, "scripts/qa/profile-posts-paging-gate.mjs")], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILE_POSTS_MUTATE: name, PROFILE_POSTS_REQUIRE_BROWSER: "1" },
    });
    const red = r.status !== 0;
    console.log(`${red ? "  ok" : "FAIL"} - mutation '${name}' RED (exit=${r.status})`);
    if (!red) { console.log(r.stdout?.slice(-1500) ?? ""); bad += 1; }
  }
  console.log(bad === 0 ? `\n✅ mutations ${names.length}/${names.length} RED + baseline GREEN` : `\n❌ ${bad} 건 실패`);
  process.exit(bad === 0 ? 0 : 1);
}

if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`FAIL: 알 수 없는 mutation '${MUTATE}' (허용: ${Object.keys(MUTATIONS).join(", ")})`);
  process.exit(1);
}

// ── 소스 계약 존재 확인(패턴이 사라지면 mutation 이 무력화되므로 fail-close) ──────
// 주석 문면이 판정을 만족시키는 false-green 을 막기 위해 블록/라인 주석을 blank 처리한 뒤 본다
// (2026-08-19 #1256 교훈: 게이트가 자기 자신의 결함을 재현했다).
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)).replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

for (const [name, [file, pattern]] of Object.entries(MUTATIONS)) {
  const body = stripComments(readFileSync(file, "utf8"));
  check(body.includes(pattern), `소스 계약 존재: ${name} 대상 패턴`);
}

// 페이지가 여전히 `.limit(` 로만 끝나지 않는지 = 회귀 원복 방지.
const pageBody = stripComments(readFileSync(PAGE_PATH, "utf8"));
check(pageBody.includes(".range(from, to)"), "프로필 페이지가 range 페이저를 쓴다");
check(!/\.eq\("author_id", authorId\)[\s\S]{0,200}\.limit\(/.test(pageBody), "작성글 조회에 limit 단독 절단이 남아있지 않다");
check(pageBody.includes("data-profile-posts-load-more"), "더보기 버튼 앵커 존재");
check(pageBody.includes("image_urls"), "작성글 조회 select 에 image_urls 포함(썸네일 입력)");
check(pageBody.includes("content_type"), "작성글 조회 select 에 content_type 포함");

// ── A. 페이징 순수 계약 (실제 소스 함수) ───────────────────────────────────────
console.log("\n[A] 페이징 순수 계약");
{
  const { from, to } = profilePostsRange(0);
  // range 는 양끝 포함이라 (to-from+1) 이 실제 요청 행수다. 한 건 더 받아야 hasMore 판정이 가능.
  check(from === 0, `page0 from=0 (got ${from})`);
  check(to - from + 1 === PROFILE_POSTS_PAGE_SIZE + 1, `page0 이 PAGE_SIZE+1 건 요청 (got ${to - from + 1})`);

  const p1 = profilePostsRange(1);
  check(p1.from === PROFILE_POSTS_PAGE_SIZE, `page1 from=${PROFILE_POSTS_PAGE_SIZE} (got ${p1.from})`);
  // 페이지 경계가 겹치거나 벌어지면 글이 중복되거나 조용히 사라진다.
  check(p1.from === from + PROFILE_POSTS_PAGE_SIZE, "페이지 경계에 중복/누락 없음");

  const full = Array.from({ length: PROFILE_POSTS_PAGE_SIZE + 1 }, (_, i) => i);
  const s1 = splitProfilePostsPage(full);
  check(s1.rows.length === PROFILE_POSTS_PAGE_SIZE, `초과분 잘라냄 (got ${s1.rows.length})`);
  check(s1.hasMore === true, "초과분 있으면 hasMore=true");

  const exact = Array.from({ length: PROFILE_POSTS_PAGE_SIZE }, (_, i) => i);
  const s2 = splitProfilePostsPage(exact);
  check(s2.rows.length === PROFILE_POSTS_PAGE_SIZE && s2.hasMore === false, "정확히 PAGE_SIZE 면 hasMore=false");

  check(nextProfilePostsPage(0) === 0, "0건 로드 → page 0");
  check(nextProfilePostsPage(PROFILE_POSTS_PAGE_SIZE) === 1, `${PROFILE_POSTS_PAGE_SIZE}건 로드 → page 1`);
  check(nextProfilePostsPage(PROFILE_POSTS_PAGE_SIZE * 2) === 2, "40건 로드 → page 2");
}

// ── B. 실제 행 컴포넌트 렌더 (Chromium) ────────────────────────────────────────
let chromiumPath = null;
try { chromiumPath = playwright.chromium.executablePath(); } catch { chromiumPath = null; }
if (!chromiumPath || !existsSync(chromiumPath)) {
  if (REQUIRE_BROWSER) { console.error("FAIL: playwright chromium 사용 불가(fail-closed)"); process.exit(1); }
  console.log("\nSKIP: playwright chromium 사용 불가 — 렌더 축 생략");
  process.exit(failures === 0 ? 0 : 1);
}

const GEN = mkdtempSync(resolve(tmpdir(), "profile-posts-"));
const SHOT = resolve(ROOT, "tmp/qa-screenshots");
mkdirSync(SHOT, { recursive: true });

// mutation 은 원본 파일을 건드리지 않고 복사본에 주입한 뒤 alias 로 갈아끼운다.
const alias = {};
if (MUTATE) {
  const [file, pattern, replacement] = MUTATIONS[MUTATE];
  const src = readFileSync(file, "utf8");
  if (!src.includes(pattern)) { console.error(`FAIL: mutation '${MUTATE}' 패턴 부재`); process.exit(1); }
  const target = resolve(GEN, `mutated-${MUTATE}.tsx`);
  writeFileSync(target, src.replace(pattern, replacement));
  if (file === ROW_PATH) alias["@/components/profile/CommunityProfilePostRow"] = target;
  if (file === PURE_PATH) alias["@/lib/utils/profile-posts-page"] = target;
  console.log(`\n  [mutation] ${MUTATE} 주입`);
}

// 순수 함수 mutation 은 브라우저가 아니라 여기서 바로 판정해야 잡힌다
// (페이지 컴포넌트를 통째로 마운트하지 않으므로).
if (MUTATE && MUTATIONS[MUTATE][0] === PURE_PATH) {
  const target = alias["@/lib/utils/profile-posts-page"];
  const mutated = await import(`file://${target}`);
  const r0 = mutated.profilePostsRange(0);
  const lookahead = r0.to - r0.from + 1 === PROFILE_POSTS_PAGE_SIZE + 1;
  const s = mutated.splitProfilePostsPage(Array.from({ length: PROFILE_POSTS_PAGE_SIZE + 1 }, (_, i) => i));
  const nextOk = mutated.nextProfilePostsPage(PROFILE_POSTS_PAGE_SIZE) === 1;
  check(lookahead, "[mutated] lookahead 유지");
  check(s.hasMore === true, "[mutated] 초과분 있으면 hasMore=true");
  check(nextOk, "[mutated] 다음 페이지 번호 진행");
}

// 1×1 투명 PNG — 외부 네트워크 의존 0.
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// fixture — 21건. 20건 페이지 뒤에 딜 1건이 더 있는 상태가 이 버그의 핵심 경계다.
// 마지막 글(#21)은 사진글이고 제목이 비어 있다 = 두 결함이 동시에 걸리는 지점.
//
// 사진글 중 **무대 3개**를 일부러 구분해 둔다(관측 가능성은 mutation 의 1급 속성):
//   n=5,15,21 → 정상 이미지        → 썸네일 렌더돼야 함
//   n=10      → [""] 빈 문자열  → 필터링 안 하면 **src 비어있는 깨진 상자**가 뜼다
//   n=20      → [] 빈 배열     → photo 인데 이미지 없는 실제 레코드(프로덕션 200건 중 11건)
// [""] 이 없으면 `image_urls?.[0]` mutation 이 undefined 를 내서 원본과 구분되지 않는다.
const BLANK_URL_POST = 10;
const EMPTY_ARRAY_POST = 20;
const POSTS = Array.from({ length: PROFILE_POSTS_PAGE_SIZE + 1 }, (_, i) => {
  const n = i + 1;
  const isPhoto = n % 5 === 0 || n === PROFILE_POSTS_PAGE_SIZE + 1;
  const imageUrls = !isPhoto ? []
    : n === BLANK_URL_POST ? ["   "]
    : n === EMPTY_ARRAY_POST ? []
    : [PIXEL];
  return {
    id: 1000 + n,
    title: isPhoto ? "" : `QA 작성글 ${n}번`,
    board_type: "team",
    board_id: "1",
    content_type: isPhoto ? "photo" : "general",
    image_urls: imageUrls,
    like_count: n,
    comment_count: 0,
    created_at: `2026-08-${String((n % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    team_tags: ["lg"],
    player_tags: [],
  };
});

writeFileSync(resolve(GEN, "entry.jsx"), `import React from "react";
import { createRoot } from "react-dom/client";
import CommunityProfilePostRow from "@/components/profile/CommunityProfilePostRow";
import { splitProfilePostsPage, nextProfilePostsPage } from "@/lib/utils/profile-posts-page";

const ALL = window.__QA_POSTS__;

/** 실제 range 페이저와 같은 방식으로 서버 응답을 흉내낸다(양끝 포함 + 초과 1건). */
function fetchPage(page){
  const size = window.__QA_PAGE_SIZE__;
  const from = page * size;
  const to = from + size; // lookahead 1건
  return splitProfilePostsPage(ALL.slice(from, to + 1));
}

function App(){
  const first = fetchPage(0);
  const [posts, setPosts] = React.useState(first.rows);
  const [hasMore, setHasMore] = React.useState(first.hasMore);
  const [guard, setGuard] = React.useState(0);
  function loadMore(){
    if (guard > 5) return; // 무한 루프 방어 — next-page-stuck mutation 이 여기 걸린다
    setGuard(guard + 1);
    const next = fetchPage(nextProfilePostsPage(posts.length));
    setPosts(prev => {
      const seen = new Set(prev.map(p => p.id));
      return [...prev, ...next.rows.filter(p => !seen.has(p.id))];
    });
    setHasMore(next.hasMore);
  }
  return React.createElement("div", { className: "space-y-3 p-3" },
    posts.map(p => React.createElement(CommunityProfilePostRow, {
      key: p.id, post: p, timeLabel: "2026.08.22", onNavigate: () => {},
    })),
    hasMore ? React.createElement("button", {
      type: "button", "data-profile-posts-load-more": "", onClick: loadMore,
    }, "더보기") : null,
  );
}
createRoot(document.getElementById("root")).render(React.createElement(App));
`);

// ThemeProvider 는 app layout 에서만 주입된다 — 행 단위 마운트에선 stub 으로 대체한다.
// 테마는 이 게이트의 판정 축(페이징·썸네일)과 무관하다.
writeFileSync(resolve(GEN, "stub-theme.jsx"), `import React from "react";
export function ThemeProvider({ children }){ return React.createElement(React.Fragment, null, children); }
export const useTheme = () => ({ theme: "dark", resolvedTheme: "dark", setTheme: () => {} });
export default { ThemeProvider, useTheme };
`);
alias["@/components/ThemeProvider"] = resolve(GEN, "stub-theme.jsx");

await build({
  entryPoints: [resolve(GEN, "entry.jsx")],
  bundle: true, format: "iife", outfile: resolve(GEN, "bundle.js"),
  jsx: "automatic", absWorkingDir: ROOT,
  nodePaths: [resolve(ROOT, "node_modules")], tsconfig: resolve(ROOT, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  // next/image 등 일부 의존이 `process` 자체를 참조한다 — 브라우저엔 없어서 런타임에 죽는다.
  banner: { js: 'var process = globalThis.process ?? { env: { NODE_ENV: "production" } };' },
  alias,
});
const bundleJs = readFileSync(resolve(GEN, "bundle.js"), "utf8");

const server = createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/bundle.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(bundleJs);
  res.writeHead(200, { "content-type": "text/html" }).end(
    `<!doctype html><html class="dark"><head><meta charset="utf8"></head>` +
    `<body style="margin:0"><div id="root"></div>` +
    `<script>window.__QA_POSTS__=${JSON.stringify(POSTS)};window.__QA_PAGE_SIZE__=${PROFILE_POSTS_PAGE_SIZE};</script>` +
    `<script src="/bundle.js"></script></body></html>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

let browser;
try { browser = await playwright.chromium.launch(); }
catch (e) {
  server.close(); rmSync(GEN, { recursive: true, force: true });
  if (REQUIRE_BROWSER) { console.error(`FAIL: chromium launch 실패 — ${e.message.split("\n")[0]}`); process.exit(1); }
  console.log(`SKIP: chromium 사용 불가 — ${e.message.split("\n")[0]}`);
  process.exit(failures === 0 ? 0 : 1);
}

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
  await page.waitForSelector("[data-community-profile-post-row]", { timeout: 8000 });

  const read = () => page.evaluate(() => ({
    rows: document.querySelectorAll("[data-community-profile-post-row]").length,
    thumbs: document.querySelectorAll("[data-profile-post-thumbnail]").length,
    hasMore: document.querySelector("[data-profile-posts-load-more]") != null,
    titles: [...document.querySelectorAll("[data-community-profile-post-row]")].map(r => (r.textContent || "").trim()),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));

  console.log("\n[B] 1페이지 렌더");
  const p1 = await read();
  await page.screenshot({ path: resolve(SHOT, "profile-posts-page1.png"), fullPage: true });
  check(p1.rows === PROFILE_POSTS_PAGE_SIZE, `1페이지 ${PROFILE_POSTS_PAGE_SIZE}행 (got ${p1.rows})`);
  check(p1.hasMore, "21번째 글이 있으므로 더보기 버튼 노출");
  check(!p1.titles.some(t => t.includes("QA 작성글 21번")), "1페이지엔 아직 21번째 글 없음");
  check(p1.overflowX <= 0, `가로 overflow 0 (delta=${p1.overflowX})`);

  // 사진글 썸네일 — 1페이지 사진글은 5·10·15·20번. 10번은 ["   "], 20번은 [] 라 둘 다 제외된다.
  const photoWithImage = [5, 15].length;
  check(p1.thumbs === photoWithImage, `이미지 있는 사진글만 썸네일 (기대 ${photoWithImage}, got ${p1.thumbs})`);
  // 공백 URL 을 그대로 통과시키면 유저 화면에 깨진 이미지 상자가 뜬다 — src 문자열을 직접 읽어 판정한다.
  const blankPhotoBroken = await page.evaluate(() =>
    [...document.querySelectorAll("[data-profile-post-thumbnail]")]
      .some(img => (img.getAttribute("src") ?? "").trim().length === 0));
  check(!blankPhotoBroken, "빈/공백 src 썸네일 없음(깨진 이미지 상자 방지)");

  console.log("\n[C] 더보기 → 21번째 글 도달");
  await page.click("[data-profile-posts-load-more]");
  await page.waitForFunction(
    (n) => document.querySelectorAll("[data-community-profile-post-row]").length > n,
    PROFILE_POSTS_PAGE_SIZE, { timeout: 5000 },
  ).catch(() => {});
  const p2 = await read();
  await page.screenshot({ path: resolve(SHOT, "profile-posts-page2.png"), fullPage: true });
  check(p2.rows === PROFILE_POSTS_PAGE_SIZE + 1, `더보기 후 ${PROFILE_POSTS_PAGE_SIZE + 1}행 (got ${p2.rows})`);
  check(!p2.hasMore, "마지막 페이지에선 더보기 사라짐");
  // 개수가 아니라 **그 글이 실제로 화면에 있는지**를 본다 — 같은 페이지 재append 로는 통과 못 한다.
  check(p2.thumbs === photoWithImage + 1, `21번째(사진글) 썸네일 추가 (기대 ${photoWithImage + 1}, got ${p2.thumbs})`);
  const ids = await page.evaluate(() => [...document.querySelectorAll("[data-community-profile-post-row]")].length);
  check(ids === PROFILE_POSTS_PAGE_SIZE + 1, "중복 append 없음(고유 21행)");

  await ctx.close();
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ profile-posts-paging-gate PASS" : `\n❌ ${failures} 건 실패`);
process.exit(failures === 0 ? 0 : 1);
