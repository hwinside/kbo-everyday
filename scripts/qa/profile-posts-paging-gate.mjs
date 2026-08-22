#!/usr/bin/env node
/**
 * 프로필 작성글 목록 회귀 게이트 — 페이징 도달성 + 미디어 썸네일 + 본문 폴백.
 *
 * 2026-08-22 하린아빠 #cs 제보 2건:
 *   ① "최근 글만 보이고 예전 글이 안 보인다" — `.limit(20)` 하드코딩 + 더보기 부재라
 *      21번째 글부터 **어떤 경로로도 도달 불가**였다(실측: 20건 초과 작성자 30명).
 *   ② "사진글은 제목 대신 썸네일" — 사진글은 `title: ""` 로 저장돼(1,424건 중 478건)
 *      제목만 그리던 행은 본문 줄이 통째로 비어 보였다.
 *   ③ 추가 지시 — 일반글 본문 첫 줄 폴백(일반글 4,440건 중 2,381건이 빈 제목).
 *
 * ⚠️ 이 게이트의 1차 판본은 **실제 페이징 배선을 태우지 않았다**(삼순 NO-GO 2026-08-22).
 * 자체 `fetchPage/loadMore` 를 재구현해 행 컴포넌트만 마운트했기 때문에, 정작 결함이 있던
 * offset 페이저(중간 삽입 시 page 영구 반복 / 삭제 시 경계 누락)를 원리적으로 볼 수 없었다.
 * 이 판본은 **실제 `ProfilePage` 를 supabase client stub 위에 마운트**해서 컴포넌트가
 * 스스로 만든 쿼리를 그대로 태운다. stub 은 쿼리 빌더 호출을 기록만 하고 메모리 테이블에
 * 적용하므로, 페이저가 offset 이면 삽입/삭제 mutation 에서 실제로 깨진다.
 *
 * 실행: node scripts/qa/profile-posts-paging-gate.mjs
 *   mutation: PROFILE_POSTS_MUTATE=<name> node scripts/qa/profile-posts-paging-gate.mjs
 *   전 mutation 일괄 RED: node scripts/qa/profile-posts-paging-gate.mjs --mutations
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
  PROFILE_POSTS_FETCH_LIMIT,
  appendProfilePosts,
  profilePostsCursorFilter,
  profilePostsCursorFrom,
  splitProfilePostsPage,
} from "../../src/lib/utils/profile-posts-page.ts";

const ROOT = process.cwd();
const MUTATE = process.env.PROFILE_POSTS_MUTATE ?? "";
const REQUIRE_BROWSER = process.env.PROFILE_POSTS_REQUIRE_BROWSER === "1";

const ROW_PATH = resolve(ROOT, "src/components/profile/CommunityProfilePostRow.tsx");
const PAGE_PATH = resolve(ROOT, "src/app/(main)/profile/[userId]/page.tsx");
const PURE_PATH = resolve(ROOT, "src/lib/utils/profile-posts-page.ts");

// 미리보기 길이 상한은 행 컴포넌트가 소유한다. .tsx 라 node 가 직접 import 하지 못하므로
// 소스에서 리터럴을 파싱해 온다 — 게이트가 상수를 재구현하면(80 을 여기 다시 적으면)
// 구현이 100 으로 바뀌어도 게이트는 계속 GREEN 이라 결함을 못 본다.
const PREVIEW_MAX_MATCH = readFileSync(ROW_PATH, "utf8").match(/export const PROFILE_POST_PREVIEW_MAX = (\d+);/);
if (!PREVIEW_MAX_MATCH) {
  console.error("FAIL: CommunityProfilePostRow 에서 PROFILE_POST_PREVIEW_MAX 리터럴을 찾지 못함(fail-close)");
  process.exit(1);
}
const PROFILE_POST_PREVIEW_MAX = Number(PREVIEW_MAX_MATCH[1]);

/**
 * mutation 이름 → [대상 파일, 원본 패턴, 변조].
 * 각 항목은 "이 PR 이 방금 고친 결함"을 되살린다. 되살렸을 때 RED 가 안 나면
 * 그 축은 게이트가 지키지 못하는 축이다.
 */
const MUTATIONS = {
  // ── 페이징 ────────────────────────────────────────────────────────────────
  // ① 커서를 아예 안 붙임 = 항상 첫 페이지 → 21번째 도달 불가(원래 버그 그대로).
  "cursor-ignored": [PAGE_PATH, "  if (cursor) query = query.or(profilePostsCursorFilter(cursor));", "  void cursor;"],
  // ② 커서 키를 created_at 단독으로 → 같은 시각 동률 글이 통째로 건너뛰어진다.
  "cursor-created-at-only": [PURE_PATH, "  return `created_at.lt.${at},and(created_at.eq.${at},id.lt.${cursor.id})`;", "  return `created_at.lt.${at}`;"],
  // ③ lookahead 제거 → hasMore 가 영영 false → 더보기 미노출.
  "no-lookahead": [PURE_PATH, "export const PROFILE_POSTS_FETCH_LIMIT = PROFILE_POSTS_PAGE_SIZE + 1;", "export const PROFILE_POSTS_FETCH_LIMIT = PROFILE_POSTS_PAGE_SIZE;"],
  // ④ hasMore 항상 false.
  "hasmore-always-false": [PURE_PATH, "  const hasMore = rows.length > PROFILE_POSTS_PAGE_SIZE;", "  const hasMore = false;"],
  // ⑤ **offset 페이저로 회귀** — 삼순이 지적한 바로 그 결함. 삽입/삭제 시나리오에서만 드러난다.
  "offset-pager": [PAGE_PATH, "  if (cursor) query = query.or(profilePostsCursorFilter(cursor));", "  if (cursor) query = query.gte(\"__offset__\", cursor.offset ?? 0);"],
  // ── 썸네일 ────────────────────────────────────────────────────────────────
  // ⑥ content_type 결속 제거 → 이미지 달린 일반글에도 썸네일이 뜬다.
  "thumbnail-ignores-content-type": [ROW_PATH, "  if (post.content_type !== PHOTO_CONTENT_TYPE) return null;", "  // content_type check removed"],
  // ⑦ 영상 폴백 제거 → 무이미지 사진글 161건이 다시 날짜만 남는다.
  "thumbnail-no-video-fallback": [ROW_PATH, '  if (firstUsableUrl(post.video_urls)) return { kind: "video" };', "  // video fallback removed"],
  // ⑧ 공백 URL 통과 → 깨진 이미지 상자.
  "thumbnail-blank-passthrough": [ROW_PATH, '  return urls?.find(url => typeof url === "string" && url.trim().length > 0) ?? null;', "  return urls?.[0] ?? null;"],
  // ── 본문 폴백 ─────────────────────────────────────────────────────────────
  // ⑨ 폴백 제거 → 제목 없는 일반글 2,381건이 다시 빈 줄.
  "preview-title-only": [ROW_PATH, '  const firstLine = (post.content ?? "")', '  if (!title) return null;\n  const firstLine = (post.content ?? "")'],
  // ⑩ 첫 줄만 안 쓰고 통째로 → 여러 줄 글이 개행 공백으로 뭉개져 붙는다.
  "preview-whole-content": [ROW_PATH, '    .split("\\n")\n    .map(line => line.trim())\n    .find(line => line.length > 0);', "    .trim() || undefined;"],
  // ⑪ 길이 상한 제거 → 660자가 그대로 DOM 에 실린다.
  "preview-no-clamp": [ROW_PATH, "  return firstLine.length > PROFILE_POST_PREVIEW_MAX", "  return firstLine.length > Number.MAX_SAFE_INTEGER"],
  // ── 공개범위 ──────────────────────────────────────────────────────────────
  // ⑫ 본인 예외 제거 → 비공개로 둔 본인이 자기 글을 못 본다.
  "private-own-blocked": [PAGE_PATH, "      if (p?.show_posts || user?.id === userId) {", "      if (p?.show_posts) {"],
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
  const base = spawnSync(process.execPath, [resolve(ROOT, "scripts/qa/profile-posts-paging-gate.mjs")], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILE_POSTS_MUTATE: "", PROFILE_POSTS_REQUIRE_BROWSER: "1" },
  });
  console.log(`[baseline] exit=${base.status} (기대 0)`);
  if (base.status !== 0) { console.log(base.stdout?.slice(-3000) ?? ""); bad += 1; }
  for (const name of names) {
    const r = spawnSync(process.execPath, [resolve(ROOT, "scripts/qa/profile-posts-paging-gate.mjs")], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILE_POSTS_MUTATE: name, PROFILE_POSTS_REQUIRE_BROWSER: "1" },
    });
    const red = r.status !== 0;
    console.log(`${red ? "  ok" : "FAIL"} - mutation '${name}' RED (exit=${r.status})`);
    if (!red) { console.log(r.stdout?.slice(-2000) ?? ""); bad += 1; }
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

console.log("[0] 소스 계약");
for (const [name, [file, pattern]] of Object.entries(MUTATIONS)) {
  // ⑤ offset-pager 는 ① 과 같은 줄을 노린다(같은 seam 의 다른 회귀). 중복 확인은 생략하지 않는다.
  const body = stripComments(readFileSync(file, "utf8"));
  check(body.includes(pattern) || pattern.startsWith("  //"), `계약 존재: ${name}`);
}

const pageBody = stripComments(readFileSync(PAGE_PATH, "utf8"));
check(pageBody.includes("profilePostsCursorFilter"), "프로필 페이지가 커서 필터를 쓴다");
check(!pageBody.includes(".range("), "offset range 페이저가 남아있지 않다");
check(pageBody.includes("data-profile-posts-load-more"), "더보기 버튼 앵커 존재");
check(/\bid, title, content,/.test(pageBody), "select 에 content 포함(본문 폴백 입력)");
check(pageBody.includes("image_urls, video_urls"), "select 에 image_urls·video_urls 포함(썸네일 입력)");
check(pageBody.includes("content_type"), "select 에 content_type 포함(사진글 판정 입력)");

// ── A. 페이징 순수 계약 (실제 소스 함수) ───────────────────────────────────────
console.log("\n[A] 페이징 순수 계약");
{
  check(PROFILE_POSTS_FETCH_LIMIT === PROFILE_POSTS_PAGE_SIZE + 1,
    `한 건 더 요청해 hasMore 판정 (got ${PROFILE_POSTS_FETCH_LIMIT})`);

  const full = Array.from({ length: PROFILE_POSTS_FETCH_LIMIT }, (_, i) => i);
  const s1 = splitProfilePostsPage(full);
  check(s1.rows.length === PROFILE_POSTS_PAGE_SIZE && s1.hasMore === true, "초과분 잘라내고 hasMore=true");

  const exact = Array.from({ length: PROFILE_POSTS_PAGE_SIZE }, (_, i) => i);
  const s2 = splitProfilePostsPage(exact);
  check(s2.rows.length === PROFILE_POSTS_PAGE_SIZE && s2.hasMore === false, "정확히 PAGE_SIZE 면 hasMore=false");

  // 커서는 마지막(=가장 오래된) 행에서 나온다.
  const rows = [
    { id: 3, created_at: "2026-08-20T00:00:00Z" },
    { id: 2, created_at: "2026-08-19T00:00:00Z" },
  ];
  const cursor = profilePostsCursorFrom(rows);
  check(cursor?.id === 2 && cursor?.createdAt === "2026-08-19T00:00:00Z",
    `커서는 마지막 행 기준 (got ${JSON.stringify(cursor)})`);
  check(profilePostsCursorFrom([]) === null, "빈 목록이면 커서 null");

  // 필터는 사전식 비교 두 절. 동률 시각을 id 로 가르지 않으면 글이 통째로 사라진다.
  const filter = profilePostsCursorFilter({ createdAt: "2026-08-19T00:00:00+09:00", id: 42 });
  check(filter.includes("created_at.lt."), "필터에 더 오래된 날짜 절 포함");
  check(/and\(created_at\.eq\..+,id\.lt\.42\)/.test(filter), `동률 시각은 id 로 가른다 (got ${filter})`);
  // timestamptz 의 `+`·`:` 가 or=(...) 문법을 깨지 않도록 quote 되어야 한다.
  check(filter.includes('"2026-08-19T00:00:00+09:00"'), `타임스탬프가 quote 됨 (got ${filter})`);

  // append 는 순서를 보존하고 중복 id 만 거른다.
  const merged = appendProfilePosts([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }]);
  check(merged.map(r => r.id).join(",") === "1,2,3", `중복 제거 + 순서 보존 (got ${merged.map(r => r.id)})`);
}

// ── B. 실제 ProfilePage 마운트 ────────────────────────────────────────────────
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

const alias = {};
if (MUTATE) {
  const [file, pattern, replacement] = MUTATIONS[MUTATE];
  const src = readFileSync(file, "utf8");
  if (!src.includes(pattern)) { console.error(`FAIL: mutation '${MUTATE}' 패턴 부재`); process.exit(1); }
  const ext = file.endsWith(".ts") ? "ts" : "tsx";
  const target = resolve(GEN, `mutated-${MUTATE}.${ext}`);
  writeFileSync(target, src.replace(pattern, replacement));
  if (file === ROW_PATH) alias["@/components/profile/CommunityProfilePostRow"] = target;
  if (file === PURE_PATH) alias["@/lib/utils/profile-posts-page"] = target;
  if (file === PAGE_PATH) alias["@/qa/ProfilePage"] = target;
  console.log(`\n  [mutation] ${MUTATE} 주입`);
}
if (!alias["@/qa/ProfilePage"]) alias["@/qa/ProfilePage"] = PAGE_PATH;

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * fixture 45건. 페이지 경계(20/40)를 두 번 넘겨야 "커서가 계속 이어지는지"를 볼 수 있다.
 *
 * 무대 배치 — mutation 이 관측 가능하려면 각 결함이 드러나는 행이 실제로 있어야 한다:
 *   n=3   제목 없는 일반글, 한 줄 본문      → 본문 폴백
 *   n=7   제목 없는 일반글, 선행 빈 줄+여러 줄 → 첫 줄만
 *   n=13  제목 없는 일반글, 660자 한 줄     → 80자 클램프
 *   n=9   제목 있는 **일반글 + 이미지**     → content_type 결속(썸네일 나오면 안 됨)
 *   n=5   사진글 + 이미지                  → 이미지 썸네일
 *   n=10  사진글 + 공백 URL 이미지          → 깨진 상자 방지
 *   n=15  사진글 + 영상만                  → 영상 플레이스홀더(전수 161건 축)
 *   n=21  경계 바로 다음 사진글            → 1페이지엔 없고 2페이지에 있어야
 *   동일 created_at 3건(n=30,31,32)        → 커서가 (created_at,id) 복합이어야 안 새는 구간
 */
const TOTAL = 45;
const ONE_LINE_POST = 3;
const MULTILINE_POST = 7;
const GENERAL_WITH_IMAGE = 9;
const BLANK_URL_POST = 10;
const LONG_LINE_POST = 13;
const VIDEO_ONLY_POST = 15;
// 동일 created_at 그룹을 **1페이지 경계에 걸치도록** 둔다(20/21/22).
// 1차 배치는 39~45 위치라 경계를 한 번도 안 걸쳐서, created_at 단독 커서 결함이
// 원리적으로 관측 불가능했다 — mutation 이 GREEN 으로 통과했다.
// 관측 가능성은 mutation 의 1급 속성이다: 무대가 없으면 결함은 결함이 아니게 된다.
const TIE_POSTS = [PROFILE_POSTS_PAGE_SIZE, PROFILE_POSTS_PAGE_SIZE + 1, PROFILE_POSTS_PAGE_SIZE + 2];
const LONG_LINE = "가".repeat(660);

function fixtureRow(n) {
  const isPhoto = n % 5 === 0;
  const titleless = isPhoto || [ONE_LINE_POST, MULTILINE_POST, LONG_LINE_POST].includes(n);
  const content =
    n === ONE_LINE_POST ? "오늘 경기 진짜 미쳤다" :
    n === MULTILINE_POST ? "\n\n  첫 줄입니다\n둘째 줄은 나오면 안 된다\n셋째 줄" :
    n === LONG_LINE_POST ? LONG_LINE :
    isPhoto ? "" : `본문 ${n}`;
  const imageUrls =
    n === GENERAL_WITH_IMAGE ? [PIXEL] :
    !isPhoto ? [] :
    n === BLANK_URL_POST ? ["   "] :
    n === VIDEO_ONLY_POST ? [] :
    [PIXEL];
  const videoUrls = n === VIDEO_ONLY_POST ? ["https://example.invalid/v.mp4"] : [];
  // 최신이 n=1 이 되도록 **엄격히** 내림차순인 시각을 만든다.
  // (1차 판본은 `Math.max(1, 28 - n)` 로 일자를 깎아 n>=27 이 전부 같은 날이 되면서
  //  정렬 순서가 n 순서와 어긋났고, 그 바람에 타이 그룹이 목록 맨 끝으로 밀렸다.)
  // 타이 3건은 그룹의 첫 번째 시각을 공유해 페이지 경계 20/21 을 가로지른다.
  const rank = TIE_POSTS.includes(n) ? TIE_POSTS[0] : n;
  const createdAt = new Date(Date.UTC(2026, 7, 28) - rank * 60_000).toISOString();
  return {
    id: 10_000 - n, // id 도 내림차순 — 최신 글이 큰 id
    title: titleless ? "" : `QA 작성글 ${n}번`,
    content,
    board_type: "team",
    board_id: "1",
    content_type: isPhoto ? "photo" : "general",
    image_urls: imageUrls,
    video_urls: videoUrls,
    like_count: n,
    comment_count: 0,
    created_at: createdAt,
    team_tags: ["lg"],
    player_tags: [],
  };
}
const POSTS = Array.from({ length: TOTAL }, (_, i) => fixtureRow(i + 1));

// ── stub 들 ───────────────────────────────────────────────────────────────────
// supabase client stub — **쿼리 빌더 계약을 그대로 흉내내고** 메모리 테이블에 적용한다.
// 이래야 컴포넌트가 스스로 만든 쿼리(커서 필터/정렬/limit)가 실제로 평가된다.
writeFileSync(resolve(GEN, "stub-client.js"), `
// 시드는 addInitScript 로 window 에 먼저 심긴다. 모듈 스코프 상태는 reload 마다 새로
// 만들어지므로, **초기화 시점에 window 에서 읽어야** reload 후에도 같은 데이터를 본다.
// (1차 판본은 evaluate 로 상태를 채운 뒤 reload 해서 시드가 통째로 날아갔다 — 내 하니스 결함.)
const seed = (typeof window !== "undefined" && window.__QA_SEED__) || {};
const state = {
  posts: seed.rows ? seed.rows.slice() : [],
  profile: seed.profile ?? null,
  failNext: Boolean(seed.failFirst),
  queries: [],
};
if (typeof window !== "undefined") window.__QA_DB__ = state;

/** PostgREST or=(a,and(b,c)) 를 평가한다. 커서 필터가 실제로 필터링되는지 보기 위함. */
function matchesOr(row, expr) {
  // 최상위 콤마로 절 분리(괄호 안 콤마는 무시)
  const parts = [];
  let depth = 0, buf = "";
  for (const ch of expr) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { parts.push(buf); buf = ""; continue; }
    buf += ch;
  }
  if (buf) parts.push(buf);
  return parts.some((part) => matchesClause(row, part));
}
function matchesClause(row, clause) {
  if (clause.startsWith("and(")) {
    const inner = clause.slice(4, -1);
    const subs = [];
    let depth = 0, buf = "";
    for (const ch of inner) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) { subs.push(buf); buf = ""; continue; }
      buf += ch;
    }
    if (buf) subs.push(buf);
    return subs.every((sub) => matchesClause(row, sub));
  }
  const m = clause.match(/^([a-z_]+)\\.(lt|gt|eq|lte|gte)\\.(.*)$/);
  if (!m) return false;
  const [, col, op, rawValue] = m;
  let value = rawValue;
  if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value);
  const left = row[col];
  const a = col === "created_at" ? String(left) : Number(left);
  const b = col === "created_at" ? String(value) : Number(value);
  if (op === "lt") return a < b;
  if (op === "gt") return a > b;
  if (op === "eq") return a === b;
  if (op === "lte") return a <= b;
  if (op === "gte") return a >= b;
  return false;
}

function builder(table) {
  const spec = { table, filters: [], orders: [], limit: null, range: null, or: null, head: false, count: null };
  const api = {
    select(_cols, opts) { spec.head = Boolean(opts && opts.head); spec.count = opts && opts.count; return api; },
    eq(col, value) { spec.filters.push({ col, value }); return api; },
    or(expr) { spec.or = expr; return api; },
    gte(col, value) { spec.filters.push({ col, value, op: "gte" }); return api; },
    order(col, opts) { spec.orders.push({ col, asc: !(opts && opts.ascending === false) }); return api; },
    limit(n) { spec.limit = n; return api.__run(); },
    range(from, to) { spec.range = [from, to]; return api.__run(); },
    maybeSingle() { return api.__run(true); },
    then(onOk, onErr) { return api.__run().then(onOk, onErr); },
    __run(single) {
      state.queries.push({ ...spec, filters: [...spec.filters], orders: [...spec.orders] });
      if (table === "profiles") return Promise.resolve({ data: state.profile, error: null });
      if (table === "user_badges") return Promise.resolve({ data: [], error: null });
      if (table !== "posts") return Promise.resolve({ data: single ? null : [], error: null });
      // 결함 주입은 **목록 조회에만** 건다. 헤더 카운트(head:true)나 like_count 합산 쿼리가
      // 먼저 소비해 버리면 정작 목록은 정상 응답을 받아 실패 시나리오가 성립하지 않는다
      // (1차 판본이 그래서 false-pass 했다 — 내 하니스 결함).
      const isListQuery = !spec.head && spec.limit != null;
      if (state.failNext && isListQuery) {
        state.failNext = false;
        return Promise.resolve({ data: null, error: { message: "qa-injected" } });
      }
      let rows = state.posts.slice();
      for (const f of spec.filters) {
        if (f.op === "gte") { rows = rows.filter((r) => Number(r[f.col] ?? 0) >= Number(f.value)); continue; }
        if (f.col === "author_id") continue; // fixture 는 단일 작성자
        rows = rows.filter((r) => r[f.col] === f.value);
      }
      if (spec.or) rows = rows.filter((r) => matchesOr(r, spec.or));
      for (const o of [...spec.orders].reverse()) {
        rows.sort((x, y) => {
          const a = x[o.col], b = y[o.col];
          const cmp = a === b ? 0 : a < b ? -1 : 1;
          return o.asc ? cmp : -cmp;
        });
      }
      const total = rows.length;
      if (spec.range) rows = rows.slice(spec.range[0], spec.range[1] + 1);
      else if (spec.limit != null) rows = rows.slice(0, spec.limit);
      if (spec.head) return Promise.resolve({ data: null, count: total, error: null });
      if (single) return Promise.resolve({ data: rows[0] ?? null, error: null });
      return Promise.resolve({ data: rows, count: total, error: null });
    },
  };
  return api;
}

export const supabase = {
  from: (table) => builder(table),
  auth: { getSession: async () => ({ data: { session: null } }), getUser: async () => ({ data: { user: null } }) },
};
export async function getSafeSession(){ return null; }
`);

writeFileSync(resolve(GEN, "stub-auth.jsx"), `import React from "react";
export function AuthProvider({ children }){ return React.createElement(React.Fragment, null, children); }
export const useAuth = () => ({ user: window.__QA_USER__ ?? null, profile: null, loading: false, signOut: async () => {}, refreshProfile: async () => {} });
export default { AuthProvider, useAuth };
`);
writeFileSync(resolve(GEN, "stub-theme.jsx"), `import React from "react";
export function ThemeProvider({ children }){ return React.createElement(React.Fragment, null, children); }
export const useTheme = () => ({ theme: "dark", resolvedTheme: "dark", setTheme: () => {} });
export default { ThemeProvider, useTheme };
`);
// next/navigation — useParams 로 대상 userId 를 주입하고 라우팅은 무해하게 삼킨다.
writeFileSync(resolve(GEN, "stub-navigation.js"), `
export const useParams = () => ({ userId: window.__QA_TARGET_ID__ });
export const useRouter = () => ({ push: (href) => { window.__QA_NAV__ = href; }, back: () => {}, replace: () => {} });
export const usePathname = () => "/profile/qa";
export const useSearchParams = () => new URLSearchParams();
`);
writeFileSync(resolve(GEN, "stub-null.jsx"), `export default function Stub(){ return null; }\nexport const HeaderProfileLink = () => null;\n`);

writeFileSync(resolve(GEN, "entry.jsx"), `import React from "react";
import { createRoot } from "react-dom/client";
import ProfilePage from "@/qa/ProfilePage";
createRoot(document.getElementById("root")).render(React.createElement(ProfilePage));
`);

Object.assign(alias, {
  "@/lib/supabase/client": resolve(GEN, "stub-client.js"),
  "@/lib/supabase/AuthContext": resolve(GEN, "stub-auth.jsx"),
  "@/components/ThemeProvider": resolve(GEN, "stub-theme.jsx"),
  "next/navigation": resolve(GEN, "stub-navigation.js"),
  "@/components/ui/HeaderProfileLink": resolve(GEN, "stub-null.jsx"),
  "@/components/ui/DMButton": resolve(GEN, "stub-null.jsx"),
  "@/components/profile/InviteTab": resolve(GEN, "stub-null.jsx"),
  "@/components/profile/BadgeDetailModal": resolve(GEN, "stub-null.jsx"),
  "@/components/profile/BadgesTab": resolve(GEN, "stub-null.jsx"),
});

await build({
  entryPoints: [resolve(GEN, "entry.jsx")],
  bundle: true, format: "iife", outfile: resolve(GEN, "bundle.js"),
  jsx: "automatic", absWorkingDir: ROOT,
  nodePaths: [resolve(ROOT, "node_modules")], tsconfig: resolve(ROOT, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  banner: { js: 'var process = globalThis.process ?? { env: { NODE_ENV: "production" } };' },
  alias,
});
const bundleJs = readFileSync(resolve(GEN, "bundle.js"), "utf8");

const server = createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/bundle.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(bundleJs);
  res.writeHead(200, { "content-type": "text/html" }).end(
    `<!doctype html><html class="dark"><head><meta charset="utf8"></head>` +
    `<body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>`,
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

const TARGET_ID = "qa-author";

/**
 * 시드 상태로 ProfilePage 를 새로 마운트한다.
 *
 * 시드는 **반드시 addInitScript 로** 넣는다. stub 의 상태는 번들 모듈 스코프라
 * 페이지 로드마다 새로 만들어지므로, goto 이후 evaluate 로 채우면 컴포넌트의 최초 조회는
 * 빈 상태를 보고, 그 뒤 reload 하면 시드가 통째로 사라진다.
 */
async function mount(page, { posts, showPosts = true, viewerId = null, failFirst = false }) {
  const profile = {
    id: TARGET_ID, nickname: "QA작성자", team_id: 1, grade: "브론즈", level: 1,
    points: 0, bio: "", is_founder: false, invite_count: 0, show_posts: showPosts,
    total_posts: posts.length, total_comments: 0, total_likes_received: 0,
    joined_at: "2026-01-01T00:00:00+00:00", favorite_players: [],
  };
  // 이전 마운트의 initScript 가 누적되면 나중 시드가 먼저 것에 덮인다 — 매번 새 컨텍스트를 쓴다.
  await page.evaluate(() => {}).catch(() => {});
  await page.addInitScript(([rows, prof, target, viewer, fail]) => {
    window.__QA_TARGET_ID__ = target;
    window.__QA_USER__ = viewer ? { id: viewer } : null;
    window.__QA_SEED__ = { rows, profile: prof, failFirst: fail };
  }, [posts, profile, TARGET_ID, viewerId, failFirst]);
  await page.goto(`http://127.0.0.1:${PORT}/?t=${Date.now()}`, { waitUntil: "load" });
  await page.waitForFunction(() => !/로딩 중/.test(document.body.innerText), null, { timeout: 8000 });
  await openPostsTab(page);
}

/** 글 탭으로 전환. 탭 라벨은 "📝 글" 고정이라 exact 텍스트로 특정한다. */
async function openPostsTab(page) {
  await page.waitForSelector("button", { timeout: 8000 });
  const clicked = await page.evaluate(() => {
    const tab = [...document.querySelectorAll("button")]
      .find((b) => (b.textContent || "").trim() === "📝 글");
    if (!tab) return false;
    tab.click();
    return true;
  });
  if (!clicked) throw new Error("글 탭 버튼을 찾지 못함 — 페이지가 기대대로 렌더되지 않았다");
  await page.waitForFunction(
    () => document.querySelector("[data-community-profile-post-row]") != null
      || /비공개 프로필|아직 작성한 글이 없어요|불러오지 못했어요/.test(document.body.innerText),
    null, { timeout: 8000 },
  );
}

const read = (page) => page.evaluate(() => ({
  rows: document.querySelectorAll("[data-community-profile-post-row]").length,
  imageThumbs: document.querySelectorAll('[data-profile-post-thumbnail="image"]').length,
  videoThumbs: document.querySelectorAll('[data-profile-post-thumbnail="video"]').length,
  hasMore: document.querySelector("[data-profile-posts-load-more]") != null,
  loadFailed: document.querySelector("[data-profile-posts-load-failed]") != null,
  hrefs: [...document.querySelectorAll("[data-community-profile-post-row]")].map(r => r.getAttribute("data-post-href")),
  previews: [...document.querySelectorAll("[data-community-profile-post-row]")]
    .map(r => r.querySelector("[data-profile-post-preview]")?.textContent ?? null),
  bodyText: document.body.innerText,
  overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
}));

/** 더보기를 끝까지 눌러 전체 도달 개수를 센다. 무한 반복은 상한으로 끊는다. */
async function exhaust(page, maxClicks = 10) {
  let clicks = 0;
  for (;;) {
    const before = await read(page);
    if (!before.hasMore) return { clicks, state: before, stalled: false };
    if (clicks >= maxClicks) return { clicks, state: before, stalled: true };
    await page.click("[data-profile-posts-load-more]");
    clicks += 1;
    await page.waitForFunction(
      (n) => document.querySelectorAll("[data-community-profile-post-row]").length !== n
        || document.querySelector("[data-profile-posts-load-more]") == null,
      before.rows, { timeout: 5000 },
    ).catch(() => {});
    const after = await read(page);
    // 눌렀는데 개수가 그대로면 같은 페이지를 다시 받은 것 = offset 페이저 결함.
    if (after.rows === before.rows && after.hasMore) {
      return { clicks, state: after, stalled: true };
    }
  }
}

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

  // ── B. 1페이지 + 미리보기/썸네일 ───────────────────────────────────────────
  console.log("\n[B] 1페이지 렌더 (실제 ProfilePage 마운트)");
  await mount(page, { posts: POSTS });
  const p1 = await read(page);
  await page.screenshot({ path: resolve(SHOT, "profile-posts-page1.png"), fullPage: true });

  check(p1.rows === PROFILE_POSTS_PAGE_SIZE, `1페이지 ${PROFILE_POSTS_PAGE_SIZE}행 (got ${p1.rows})`);
  check(p1.hasMore, `총 ${TOTAL}건이므로 더보기 노출`);
  check(!p1.loadFailed, "조회 실패 표시 없음");
  check(p1.overflowX <= 0, `가로 overflow 0 (delta=${p1.overflowX})`);

  const idOf = (n) => 10_000 - n;
  const hrefOf = (n) => `/community/teams/1/posts/${idOf(n)}`;
  const indexOfPost = (state, n) => state.hrefs.indexOf(hrefOf(n));
  const previewOf = (state, n) => {
    const i = indexOfPost(state, n);
    return i < 0 ? undefined : state.previews[i];
  };

  // 썸네일 — content_type='photo' 에만. 이미지 달린 일반글에는 나오면 안 된다.
  check(indexOfPost(p1, GENERAL_WITH_IMAGE) >= 0, "일반글+이미지 행이 1페이지에 있다(무대 확인)");
  const generalHasThumb = await page.evaluate((href) => {
    const row = [...document.querySelectorAll("[data-community-profile-post-row]")]
      .find(r => r.getAttribute("data-post-href") === href);
    return row ? row.querySelector("[data-profile-post-thumbnail]") != null : null;
  }, hrefOf(GENERAL_WITH_IMAGE));
  check(generalHasThumb === false, `이미지 달린 일반글엔 썸네일 없음 (got ${generalHasThumb})`);

  const photoHasThumb = await page.evaluate((href) => {
    const row = [...document.querySelectorAll("[data-community-profile-post-row]")]
      .find(r => r.getAttribute("data-post-href") === href);
    return row?.querySelector("[data-profile-post-thumbnail]")?.getAttribute("data-profile-post-thumbnail") ?? null;
  }, hrefOf(5));
  check(photoHasThumb === "image", `사진글엔 이미지 썸네일 (got ${photoHasThumb})`);

  // 영상만 있는 사진글(전수 161건 축) — 플레이스홀더가 떠야 한다.
  const videoKind = await page.evaluate((href) => {
    const row = [...document.querySelectorAll("[data-community-profile-post-row]")]
      .find(r => r.getAttribute("data-post-href") === href);
    return row?.querySelector("[data-profile-post-thumbnail]")?.getAttribute("data-profile-post-thumbnail") ?? null;
  }, hrefOf(VIDEO_ONLY_POST));
  check(videoKind === "video", `이미지 없는 영상 사진글은 영상 플레이스홀더 (got ${videoKind})`);
  check(previewOf(p1, VIDEO_ONLY_POST) === "영상", `영상글 미리보기 문구 (got ${JSON.stringify(previewOf(p1, VIDEO_ONLY_POST))})`);

  // 공백 URL 사진글 — 깨진 상자 방지.
  const blankBroken = await page.evaluate(() =>
    [...document.querySelectorAll('[data-profile-post-thumbnail="image"]')]
      .some(img => (img.getAttribute("src") ?? "").trim().length === 0));
  check(!blankBroken, "빈/공백 src 이미지 썸네일 없음");

  // 본문 폴백.
  check(previewOf(p1, ONE_LINE_POST) === "오늘 경기 진짜 미쳤다",
    `제목 없는 일반글이 본문으로 대체 (got ${JSON.stringify(previewOf(p1, ONE_LINE_POST))})`);
  check(previewOf(p1, MULTILINE_POST) === "첫 줄입니다",
    `여러 줄 글은 첫 줄만 (got ${JSON.stringify(previewOf(p1, MULTILINE_POST))})`);
  check(!(previewOf(p1, MULTILINE_POST) ?? "").includes("둘째 줄"), "둘째 줄이 섞이지 않음");
  const longPreview = previewOf(p1, LONG_LINE_POST) ?? "";
  check(longPreview.length > 0 && longPreview.length <= PROFILE_POST_PREVIEW_MAX + 1,
    `긴 첫 줄은 ${PROFILE_POST_PREVIEW_MAX}자로 자름 (got ${longPreview.length}자)`);
  check(longPreview.endsWith("…"), "말줄임 표기");
  check(previewOf(p1, 1) === "QA 작성글 1번", `제목 있으면 제목 우선 (got ${JSON.stringify(previewOf(p1, 1))})`);

  // ── C. 끝까지 도달 ────────────────────────────────────────────────────────
  console.log("\n[C] 더보기로 전체 도달");
  const exhausted = await exhaust(page);
  await page.screenshot({ path: resolve(SHOT, "profile-posts-exhausted.png"), fullPage: true });
  check(!exhausted.stalled, `더보기가 멈추지 않고 끝까지 진행 (clicks=${exhausted.clicks})`);
  check(exhausted.state.rows === TOTAL, `전체 ${TOTAL}건 도달 (got ${exhausted.state.rows})`);
  check(!exhausted.state.hasMore, "끝에서 더보기 사라짐");
  // 21번째 = 1페이지 경계 바로 다음. 개수가 아니라 **그 글의 존재**로 본다.
  check(indexOfPost(exhausted.state, PROFILE_POSTS_PAGE_SIZE + 1) >= 0, "21번째 글이 실제로 화면에 있다");
  check(indexOfPost(exhausted.state, TOTAL) >= 0, `마지막 ${TOTAL}번째 글도 도달`);
  // 동일 created_at 3건이 모두 살아있어야 한다 — 커서가 created_at 단독이면 여기서 샌다.
  for (const n of TIE_POSTS) {
    check(indexOfPost(exhausted.state, n) >= 0, `동일 시각 글 n=${n} 누락 없음(페이지 경계 가로지름)`);
  }
  check(new Set(exhausted.state.hrefs).size === exhausted.state.hrefs.length, "중복 행 없음");

  // ── D. 목록이 움직이는 동안의 더보기 (offset 페이저가 깨지는 지점) ─────────
  console.log("\n[D] 1페이지 조회 후 새 글 삽입 → 이어보기");
  await mount(page, { posts: POSTS });
  const before = await read(page);
  check(before.rows === PROFILE_POSTS_PAGE_SIZE, "재마운트 1페이지 정상");
  // 목록 맨 앞에 새 글을 하나 넣는다(유저가 글을 쓰는 흔한 상황).
  await page.evaluate(() => {
    const db = window.__QA_DB__;
    db.posts = [{
      id: 99_999, title: "삽입된 새 글", content: "", board_type: "team", board_id: "1",
      content_type: "general", image_urls: [], video_urls: [], like_count: 0, comment_count: 0,
      created_at: "2026-12-31T00:00:00+00:00", team_tags: ["lg"], player_tags: [],
    }, ...db.posts];
  });
  const afterInsert = await exhaust(page);
  check(!afterInsert.stalled, `삽입 후에도 더보기가 진행됨 (clicks=${afterInsert.clicks})`);
  // 커서는 "마지막으로 본 글 다음"이라 삽입과 무관하게 원래 45건을 모두 이어받는다.
  check(afterInsert.state.rows === TOTAL, `삽입 후에도 원래 ${TOTAL}건 전부 도달 (got ${afterInsert.state.rows})`);
  check(indexOfPost(afterInsert.state, TOTAL) >= 0, "삽입 후에도 마지막 글 도달");

  console.log("\n[E] 1페이지 조회 후 경계 글 삭제 → 건너뜀 없음");
  await mount(page, { posts: POSTS });
  await page.evaluate((removeId) => {
    const db = window.__QA_DB__;
    db.posts = db.posts.filter((r) => r.id !== removeId);
  }, idOf(2)); // 1페이지 안쪽 글 삭제
  const afterDelete = await exhaust(page);
  check(!afterDelete.stalled, "삭제 후에도 더보기가 진행됨");
  // 21번째 글은 여전히 나와야 한다(offset 이면 경계가 한 칸 밀려 건너뛴다).
  check(indexOfPost(afterDelete.state, PROFILE_POSTS_PAGE_SIZE + 1) >= 0, "삭제 후에도 경계 글 누락 없음");
  check(indexOfPost(afterDelete.state, TOTAL) >= 0, "삭제 후에도 마지막 글 도달");

  // ── F. 공개범위 ───────────────────────────────────────────────────────────
  console.log("\n[F] 비공개 프로필");
  await mount(page, { posts: POSTS, showPosts: false, viewerId: TARGET_ID });
  const ownPrivate = await read(page);
  check(ownPrivate.rows === PROFILE_POSTS_PAGE_SIZE,
    `비공개여도 본인은 자기 글을 본다 (got ${ownPrivate.rows})`);

  await mount(page, { posts: POSTS, showPosts: false, viewerId: "someone-else" });
  const otherPrivate = await read(page);
  check(otherPrivate.rows === 0, `비공개 프로필은 타인에게 글 0행 (got ${otherPrivate.rows})`);
  check(/비공개 프로필/.test(otherPrivate.bodyText), "타인에겐 비공개 안내 노출");

  // ── G. 조회 실패는 "글 없음"이 아니다 ─────────────────────────────────────
  console.log("\n[G] 조회 실패 구분");
  const failCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const failPage = await failCtx.newPage();
  failPage.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  await mount(failPage, { posts: POSTS, failFirst: true });
  const failed = await read(failPage);
  check(failed.rows === 0, "조회 실패 시 행 0");
  check(failed.loadFailed, "조회 실패는 전용 안내로 구분(‘글이 없어요’ 아님)");
  check(!/아직 작성한 글이 없어요/.test(failed.bodyText), "실패를 ‘글 없음’으로 오도하지 않음");
  await failCtx.close();

  await ctx.close();
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ profile-posts-paging-gate PASS" : `\n❌ ${failures} 건 실패`);
process.exit(failures === 0 ? 0 : 1);
