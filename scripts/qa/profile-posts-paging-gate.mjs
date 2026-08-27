#!/usr/bin/env node
/**
 * 프로필 작성글 목록 회귀 게이트 — 페이징 도달성 + 미디어 썸네일 + 본문 폴백.
 *
 * 2026-08-22 하린아빠 #cs 제보:
 *   ① "최근 글만 보이고 예전 글이 안 보인다" — `.limit(20)` 하드코딩 + 더보기 부재라
 *      21번째 글부터 **어떤 경로로도 도달 불가**였다(실측: 20건 초과 작성자 30명).
 *   ② "사진글은 제목 대신 썸네일" — 사진글은 `title: ""` 로 저장돼(1,424건 중 478건)
 *      제목만 그리던 행은 본문 줄이 통째로 비어 보였다.
 *   ③ "일반글 본문 첫 줄 폴백까지" — 일반글 4,440건 중 2,381건이 빈 제목.
 *
 * ── 이 게이트가 두 번 고쳐진 이력(삼순 NO-GO) ───────────────────────────────
 * 1차: 자체 `fetchPage/loadMore` 를 재구현해 행 컴포넌트만 마운트 → 정작 결함이 있던
 *      페이저를 원리적으로 볼 수 없었다.
 * 2차: 실제 `ProfilePage` 를 마운트했지만 (a) 시나리오마다 같은 page 에 initScript 를
 *      누적해 seed 가 서로 덮을 수 있었고 (b) `offset-pager` mutation 이 없는 컬럼에
 *      `gte(...,0)` 를 걸어 사실상 `cursor-ignored` 복제였다.
 * 3차(현재): 시나리오마다 새 context/page 로 격리 + **실제 `.range` offset 회귀** 주입.
 *      그리고 소스 계약 검사가 **원본이 아니라 변조된 산출물**을 읽는다 — 이래야
 *      브라우저가 없는 실행면(CI 러너)에서도 mutation 이 RED 가 된다.
 *
 * 축(axis) 계약:
 *   source — 변조된 소스 텍스트에서 계약 패턴이 사라졌는지. 브라우저 불필요.
 *   pure   — 변조된 순수 모듈을 실제로 실행해 산식이 깨졌는지. 브라우저 불필요.
 *   dom    — 실제 ProfilePage 를 Chromium 에 마운트해 행동이 깨졌는지.
 * 브라우저가 있으면 세 축 전부, 없으면 source+pure 만 돈다. `--mutations` 는 브라우저가
 * 있을 때 **dom 축에서도 RED 여야 하는 mutation** 을 따로 검사해, source 축이 dom 축을
 * 가려버리는 false-confidence 를 막는다.
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
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const ROOT = process.cwd();
const MUTATE = process.env.PROFILE_POSTS_MUTATE ?? "";
const REQUIRE_BROWSER = process.env.PROFILE_POSTS_REQUIRE_BROWSER === "1";

const ROW_PATH = resolve(ROOT, "src/components/profile/CommunityProfilePostRow.tsx");
const PAGE_PATH = resolve(ROOT, "src/app/(main)/profile/[userId]/page.tsx");
const PURE_PATH = resolve(ROOT, "src/lib/utils/profile-posts-page.ts");
// 표시 판정(미리보기·썸네일)의 순수 계약. .tsx 안에 두면 node 가 직접 import 하지 못해
// 브라우저 없는 실행면에서 결함주입이 통과해버린다 — 실제로 preview-title-only 가 그랬다.
const PREVIEW_PATH = resolve(ROOT, "src/lib/utils/profile-post-preview.ts");

/**
 * mutation 이름 → { file, edits, dom }.
 *   edits — [원본, 변조] 쌍의 배열. 여러 곳을 한 번에 바꿔야 하는 회귀가 있다(offset 복원).
 *   dom   — 브라우저가 있을 때 **dom 축에서도** RED 여야 하면 true.
 *           (소스 텍스트만으로 잡히는 것과 실제 행동이 깨지는 것은 다른 증거다.)
 */
const MUTATIONS = {
  // ── 페이징 ────────────────────────────────────────────────────────────────
  // ① 커서를 아예 안 붙임 = 항상 첫 페이지 → 21번째 도달 불가(원래 버그 그대로).
  "cursor-ignored": {
    file: PAGE_PATH, dom: true,
    edits: [["  if (cursor) query = query.or(profilePostsCursorFilter(cursor));", "  void cursor;"]],
  },
  // ② 커서 키에서 id 제거 → 같은 시각 동률 글이 통째로 건너뛰어진다.
  "cursor-created-at-only": {
    file: PURE_PATH, dom: true,
    edits: [["  return `created_at.lt.${at},and(created_at.eq.${at},id.lt.${cursor.id})`;", "  return `created_at.lt.${at}`;"]],
  },
  // ③ lookahead 제거 → hasMore 가 영영 false → 더보기 미노출.
  "no-lookahead": {
    file: PURE_PATH, dom: true,
    edits: [["export const PROFILE_POSTS_FETCH_LIMIT = PROFILE_POSTS_PAGE_SIZE + 1;", "export const PROFILE_POSTS_FETCH_LIMIT = PROFILE_POSTS_PAGE_SIZE;"]],
  },
  // ④ hasMore 항상 false.
  "hasmore-always-false": {
    file: PURE_PATH, dom: true,
    edits: [["  const hasMore = rows.length > PROFILE_POSTS_PAGE_SIZE;", "  const hasMore = false;"]],
  },
  // ⑤ **진짜 offset 페이저로 회귀** — 삼순 NO-GO 2건째.
  //    이전 판본은 없는 `__offset__` 컬럼에 `gte(...,0)` 을 걸어 필터가 사실상 없는 것과
  //    같았고, 그래서 `cursor-ignored` 를 복제했을 뿐 삽입/삭제 경계를 증명하지 못했다.
  //    여기서는 실제로 `.range(from, from+PAGE)` 를 쓰고 페이지 번호를 `posts.length` 에서
  //    유도한다 — 커밋 전 구현과 동일한 구조다.
  "offset-pager": {
    file: PAGE_PATH, dom: true,
    edits: [
      [
        `  if (cursor) query = query.or(profilePostsCursorFilter(cursor));
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PROFILE_POSTS_FETCH_LIMIT);`,
        `  const __offsetFrom = ((cursor)?.offsetPage ?? 0) * (PROFILE_POSTS_FETCH_LIMIT - 1);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(__offsetFrom, __offsetFrom + (PROFILE_POSTS_FETCH_LIMIT - 1));`,
      ],
      [
        "    const cursor = profilePostsCursorFrom(posts);",
        "    const cursor = { ...(profilePostsCursorFrom(posts) ?? { createdAt: \"\", id: 0 }), offsetPage: Math.floor(posts.length / (PROFILE_POSTS_FETCH_LIMIT - 1)) };",
      ],
    ],
  },
  // ── 썸네일 ────────────────────────────────────────────────────────────────
  // ⑥ content_type 결속 제거 → 이미지 달린 일반글에도 썸네일이 뜬다.
  "thumbnail-ignores-content-type": {
    file: PREVIEW_PATH, dom: true,
    edits: [["  if (post.content_type !== PHOTO_CONTENT_TYPE) return null;", "  /* removed */"]],
  },
  // ⑦ 영상 폴백 제거 → 무이미지 사진글 161건이 다시 날짜만 남는다.
  "thumbnail-no-video-fallback": {
    file: PREVIEW_PATH, dom: true,
    edits: [['  if (firstUsableUrl(post.video_urls)) return { kind: "video" };', "  /* removed */"]],
  },
  // ⑧ 공백 URL 통과 → 깨진 이미지 상자.
  "thumbnail-blank-passthrough": {
    file: PREVIEW_PATH, dom: true,
    edits: [['  return urls?.find(url => typeof url === "string" && url.trim().length > 0) ?? null;', "  return urls?.[0] ?? null;"]],
  },
  // ── 본문 폴백 ─────────────────────────────────────────────────────────────
  // ⑨ 폴백 제거 → 제목 없는 일반글 2,381건이 다시 빈 줄.
  "preview-title-only": {
    file: PREVIEW_PATH, dom: true,
    edits: [['  const firstLine = (post.content ?? "")', '  if (!title) return null;\n  const firstLine = (post.content ?? "")']],
  },
  // ⑩ 첫 줄만 안 쓰고 통째로 → 여러 줄 글이 개행 공백으로 뭉개져 붙는다.
  "preview-whole-content": {
    file: PREVIEW_PATH, dom: true,
    edits: [['    .split("\\n")\n    .map(line => line.trim())\n    .find(line => line.length > 0);', "    .trim() || undefined;"]],
  },
  // ⑪ 길이 상한 제거 → 660자가 그대로 DOM 에 실린다.
  "preview-no-clamp": {
    file: PREVIEW_PATH, dom: true,
    edits: [["  return firstLine.length > PROFILE_POST_PREVIEW_MAX", "  return firstLine.length > Number.MAX_SAFE_INTEGER"]],
  },
  // ── 공개범위 ──────────────────────────────────────────────────────────────
  // ⑫ 본인 예외 제거 → 비공개로 둔 본인이 자기 글을 못 본다.
  "private-own-blocked": {
    file: PAGE_PATH, dom: true,
    edits: [["      if (p?.show_posts || user?.id === userId) {", "      if (p?.show_posts) {"]],
  },
};

// ── 실행 상태 ────────────────────────────────────────────────────────────────
let failures = 0;
let section = "0";
const failedSections = new Set();
const check = (cond, msg) => {
  console.log(`${cond ? "  ok" : "FAIL"} - ${msg}`);
  if (!cond) { failures += 1; failedSections.add(section); }
};
const DOM_SECTIONS = new Set(["B", "C", "D", "E", "F", "G"]);

function chromiumAvailable() {
  try {
    const p = playwright.chromium.executablePath();
    return Boolean(p) && existsSync(p);
  } catch { return false; }
}

function finish() {
  // 어느 축에서 실패했는지 부모 프로세스가 읽는다. 소스 축이 DOM 축을 가리는지 확인용.
  console.log(`SECTIONS_FAILED=${[...failedSections].join(",") || "-"}`);
  console.log(failures === 0 ? "\n✅ profile-posts-paging-gate PASS" : `\n❌ ${failures} 건 실패`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── --mutations: 각 mutation 이 실제로 RED 인지 서브프로세스로 증명 ───────────
if (process.argv.includes("--mutations")) {
  const names = Object.keys(MUTATIONS);
  const hasBrowser = chromiumAvailable();

  // 호출자가 REQUIRE_BROWSER=1 로 **DOM 축을 명시 요구**했는데 브라우저가 없으면 즉시 RED.
  // 이게 없으면 "브라우저 워크플로가 덮는다"고 적어놓고 실제로는 아무도 DOM 축을 돌리지
  // 않는 상태가 조용히 성립한다 — 실제로 그랬다(삼순 NO-GO 2026-08-22:
  // required CI 어디에서도 profile-posts DOM 축이 실행되지 않았는데 12/12 RED 로 보고됨).
  if (REQUIRE_BROWSER && !hasBrowser) {
    console.error("FAIL: PROFILE_POSTS_REQUIRE_BROWSER=1 인데 chromium 이 없다(fail-close) — DOM 축 요구가 충족되지 않음");
    process.exit(1);
  }
  console.log(hasBrowser
    ? `[axes] source + pure + dom (chromium 사용 가능${REQUIRE_BROWSER ? ", DOM 축 필수 요구됨" : ""})`
    : "[axes] source + pure (chromium 없음 — DOM 축 생략. 이 실행은 DOM 회귀를 증명하지 않는다)");
  let bad = 0;
  const run = (name) => spawnSync(process.execPath, [resolve(ROOT, "scripts/qa/profile-posts-paging-gate.mjs")], {
    cwd: ROOT, encoding: "utf8",
    // 브라우저가 있으면 fail-close(SKIP 을 성공으로 세지 않음), 없으면 축을 줄여 정직하게 돈다.
    env: { ...process.env, PROFILE_POSTS_MUTATE: name, PROFILE_POSTS_REQUIRE_BROWSER: hasBrowser ? "1" : "0" },
  });

  const base = run("");
  console.log(`[baseline] exit=${base.status} (기대 0)`);
  if (base.status !== 0) { console.log(base.stdout?.slice(-3000) ?? ""); bad += 1; }

  for (const name of names) {
    const r = run(name);
    const red = r.status !== 0;
    const sections = (r.stdout?.match(/SECTIONS_FAILED=(\S*)/)?.[1] ?? "").split(",").filter(s => s && s !== "-");
    const domRed = sections.some(s => DOM_SECTIONS.has(s));
    let ok = red;
    let note = `exit=${r.status}, sections=${sections.join("|") || "-"}`;
    // 브라우저가 있는데 dom 축이 조용하면, 그 mutation 은 "소스에 문자열이 사라졌다"만
    // 증명한 것이다. 행동 회귀를 주장하려면 dom 축에서도 깨져야 한다.
    if (ok && hasBrowser && MUTATIONS[name].dom && !domRed) {
      ok = false;
      note += " — dom 축 무반응(소스 축만 RED)";
    }
    console.log(`${ok ? "  ok" : "FAIL"} - mutation '${name}' RED (${note})`);
    if (!ok) { console.log(r.stdout?.slice(-2000) ?? ""); bad += 1; }
  }
  const axisNote = hasBrowser ? "source+pure+dom 축" : "source+pure 축만 (DOM 회귀 미증명)";
  console.log(bad === 0
    ? `\n✅ mutations ${names.length}/${names.length} RED + baseline GREEN — ${axisNote}`
    : `\n❌ ${bad} 건 실패 — ${axisNote}`);
  process.exit(bad === 0 ? 0 : 1);
}

if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`FAIL: 알 수 없는 mutation '${MUTATE}' (허용: ${Object.keys(MUTATIONS).join(", ")})`);
  process.exit(1);
}

const GEN = mkdtempSync(resolve(tmpdir(), "profile-posts-"));

// ── 변조 산출물 준비 ─────────────────────────────────────────────────────────
// 핵심: 이후 **모든 검사가 이 산출물을 읽는다**. 원본을 읽으면 mutation 은 소스 축에서
// 영영 안 잡히고, 브라우저가 없는 실행면에서 게이트 검증력이 0 이 된다.
const artifacts = new Map([[ROW_PATH, ROW_PATH], [PAGE_PATH, PAGE_PATH], [PURE_PATH, PURE_PATH], [PREVIEW_PATH, PREVIEW_PATH]]);
if (MUTATE) {
  const { file, edits } = MUTATIONS[MUTATE];
  let src = readFileSync(file, "utf8");
  for (const [pattern, replacement] of edits) {
    if (!src.includes(pattern)) {
      console.error(`FAIL: mutation '${MUTATE}' 패턴 부재 — ${pattern.slice(0, 60)}…`);
      rmSync(GEN, { recursive: true, force: true });
      process.exit(1);
    }
    src = src.replace(pattern, replacement);
  }
  const ext = file.endsWith(".ts") ? "ts" : "tsx";
  const target = resolve(GEN, `mutated-${MUTATE}.${ext}`);
  writeFileSync(target, src);
  artifacts.set(file, target);
  console.log(`  [mutation] ${MUTATE} 주입 (${edits.length}곳)`);
}
const sourceOf = (file) => readFileSync(artifacts.get(file), "utf8");

// 미리보기 길이 상한은 행 컴포넌트가 소유한다. 게이트가 상수를 재구현하면(80 을 여기 다시
// 적으면) 구현이 100 으로 바뀌어도 계속 GREEN 이라 결함을 못 본다 — 소스에서 파싱한다.
const PREVIEW_MAX_MATCH = sourceOf(PREVIEW_PATH).match(/export const PROFILE_POST_PREVIEW_MAX = (\d+);/);
if (!PREVIEW_MAX_MATCH) {
  console.error("FAIL: PROFILE_POST_PREVIEW_MAX 리터럴을 찾지 못함(fail-close)");
  rmSync(GEN, { recursive: true, force: true });
  process.exit(1);
}
const PROFILE_POST_PREVIEW_MAX = Number(PREVIEW_MAX_MATCH[1]);

// ── [0] 소스 계약 (축: source) ───────────────────────────────────────────────
// 주석 문면이 판정을 만족시키는 false-green 을 막기 위해 주석을 blank 처리한 뒤 본다
// (2026-08-19 #1256 교훈: 게이트가 자기 자신의 결함을 재현했다).
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)).replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

section = "0";
console.log("\n[0] 소스 계약 (변조 산출물 대상)");
const pageBody = stripComments(sourceOf(PAGE_PATH));
const previewBody = stripComments(sourceOf(PREVIEW_PATH));
const rowBody = stripComments(sourceOf(ROW_PATH));
const pureBody = stripComments(sourceOf(PURE_PATH));

check(pageBody.includes("profilePostsCursorFilter(cursor)"), "페이지가 커서 필터를 실제로 건다");
check(!pageBody.includes(".range("), "offset range 페이저가 없다");
check(pageBody.includes("PROFILE_POSTS_FETCH_LIMIT"), "lookahead 상수로 조회한다");
check(pageBody.includes("data-profile-posts-load-more"), "더보기 버튼 앵커 존재");
check(/\bid, title, content,/.test(pageBody), "select 에 content 포함(본문 폴백 입력)");
check(pageBody.includes("image_urls, video_urls"), "select 에 image_urls·video_urls 포함");
check(pageBody.includes("content_type"), "select 에 content_type 포함");
check(pageBody.includes("p?.show_posts || user?.id === userId"), "비공개여도 본인은 조회한다");
check(pageBody.includes("profilePostsCursorFrom(posts)"), "더보기가 마지막 행에서 커서를 만든다");
check(pureBody.includes("id.lt.${cursor.id}"), "커서 필터가 동률 시각을 id 로 가른다");
check(pureBody.includes("PROFILE_POSTS_PAGE_SIZE + 1"), "lookahead 가 한 건 더 요청한다");
check(pureBody.includes("rows.length > PROFILE_POSTS_PAGE_SIZE"), "hasMore 가 초과분으로 판정된다");
check(previewBody.includes("post.content_type !== PHOTO_CONTENT_TYPE"), "썸네일이 사진글에 결속된다");
check(previewBody.includes('return { kind: "video" }'), "무이미지 사진글은 영상 폴백");
check(previewBody.includes("url.trim().length > 0"), "공백 URL 을 썸네일로 쓰지 않는다");
check(previewBody.includes(".find(line => line.length > 0)"), "본문은 첫 유효 줄만 쓴다");
check(previewBody.includes("firstLine.length > PROFILE_POST_PREVIEW_MAX"), "미리보기 길이 상한 적용");
check(/const title = \(post\.title \?\? ""\)\.trim\(\);\s*\n\s*if \(title\) return title;/.test(previewBody),
  "미리보기는 제목 우선, 그 다음 본문");
// 행 컴포넌트가 판정을 재구현하지 않고 순수 계약을 그대로 쓰는지 — 재구현하면 게이트가
// 순수 모듈만 지키고 실제 화면은 다른 로직으로 굴러가게 된다.
check(rowBody.includes('from "@/lib/utils/profile-post-preview"'), "행 컴포넌트가 순수 표시 계약을 import 한다");
check(rowBody.includes("profilePostThumbnail(post)") && rowBody.includes("profilePostPreviewText(post)"),
  "행 컴포넌트가 순수 판정 함수를 실제로 호출한다");

// ── [A] 페이징 순수 계약 (축: pure — 변조된 모듈을 실제로 실행) ───────────────
section = "A";
console.log("\n[A] 페이징 순수 계약 (변조 모듈 실행)");
const pure = await import(pathToFileURL(artifacts.get(PURE_PATH)).href);
const {
  PROFILE_POSTS_PAGE_SIZE,
  PROFILE_POSTS_FETCH_LIMIT,
  appendProfilePosts,
  profilePostsCursorFilter,
  profilePostsCursorFrom,
  splitProfilePostsPage,
} = pure;
{
  check(PROFILE_POSTS_FETCH_LIMIT === PROFILE_POSTS_PAGE_SIZE + 1,
    `한 건 더 요청해 hasMore 판정 (got ${PROFILE_POSTS_FETCH_LIMIT})`);

  const s1 = splitProfilePostsPage(Array.from({ length: PROFILE_POSTS_PAGE_SIZE + 1 }, (_, i) => i));
  check(s1.rows.length === PROFILE_POSTS_PAGE_SIZE && s1.hasMore === true, "초과분 잘라내고 hasMore=true");

  const s2 = splitProfilePostsPage(Array.from({ length: PROFILE_POSTS_PAGE_SIZE }, (_, i) => i));
  check(s2.rows.length === PROFILE_POSTS_PAGE_SIZE && s2.hasMore === false, "정확히 PAGE_SIZE 면 hasMore=false");

  const cursor = profilePostsCursorFrom([
    { id: 3, created_at: "2026-08-20T00:00:00Z" },
    { id: 2, created_at: "2026-08-19T00:00:00Z" },
  ]);
  check(cursor?.id === 2 && cursor?.createdAt === "2026-08-19T00:00:00Z",
    `커서는 마지막 행 기준 (got ${JSON.stringify(cursor)})`);
  check(profilePostsCursorFrom([]) === null, "빈 목록이면 커서 null");

  const filter = profilePostsCursorFilter({ createdAt: "2026-08-19T00:00:00+09:00", id: 42 });
  check(filter.includes("created_at.lt."), "필터에 더 오래된 날짜 절 포함");
  check(/and\(created_at\.eq\..+,id\.lt\.42\)/.test(filter), `동률 시각은 id 로 가른다 (got ${filter})`);
  check(filter.includes('"2026-08-19T00:00:00+09:00"'), "타임스탬프가 quote 됨");

  const merged = appendProfilePosts([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }]);
  check(merged.map(r => r.id).join(",") === "1,2,3", `중복 제거 + 순서 보존 (got ${merged.map(r => r.id)})`);
}

// ── [A2] 표시 판정 순수 계약 (축: pure — 변조된 모듈을 실제로 실행) ──────────
// 이 축이 없으면 미리보기·썸네일 결함주입은 **브라우저가 있을 때만** 잡힌다.
// CI 러너에는 chromium 이 없어서, 실제로 preview-title-only 가 조용히 통과했다.
section = "A2";
console.log("\n[A2] 표시 판정 순수 계약 (변조 모듈 실행)");
const view = await import(pathToFileURL(artifacts.get(PREVIEW_PATH)).href);
{
  const { profilePostPreviewText, profilePostThumbnail, PROFILE_POST_PREVIEW_MAX: MAX } = view;
  const post = (over) => ({
    id: 1, title: "", content: "", board_type: "team", board_id: "1",
    content_type: "general", image_urls: [], video_urls: [],
    like_count: 0, comment_count: 0, created_at: "2026-08-01T00:00:00Z", ...over,
  });

  // 미리보기 — 제목 우선, 그 다음 본문 첫 줄.
  check(profilePostPreviewText(post({ title: "제목", content: "본문" })) === "제목", "제목이 있으면 제목");
  check(profilePostPreviewText(post({ content: "오늘 경기 진짜 미쳤다" })) === "오늘 경기 진짜 미쳤다",
    "제목이 없으면 본문 첫 줄로 대체");
  check(profilePostPreviewText(post({ content: "\n\n  첫 줄\n둘째 줄" })) === "첫 줄",
    "선행 빈 줄을 건너뛰고 첫 유효 줄만");
  check(profilePostPreviewText(post({})) === null, "제목·본문 둘 다 없으면 null");
  const long = profilePostPreviewText(post({ content: "가".repeat(660) })) ?? "";
  check(long.length === MAX + 1 && long.endsWith("…"), `길이 상한 ${MAX}자 + 말줄임 (got ${long.length}자)`);

  // 썸네일 — 사진글 한정, 이미지 → 영상 순.
  const photoImg = profilePostThumbnail(post({ content_type: "photo", image_urls: ["https://x/i.png"] }));
  check(photoImg?.kind === "image" && photoImg.url === "https://x/i.png", "사진글 + 이미지 → image 썸네일");
  const photoVid = profilePostThumbnail(post({ content_type: "photo", video_urls: ["https://x/v.mp4"] }));
  check(photoVid?.kind === "video", "사진글 + 영상만 → video 플레이스홀더(전수 161건 축)");
  check(profilePostThumbnail(post({ content_type: "photo", image_urls: ["   "] })) === null,
    "공백 URL 은 썸네일로 쓰지 않는다");
  check(profilePostThumbnail(post({ content_type: "general", image_urls: ["https://x/i.png"] })) === null,
    "이미지 달린 일반글엔 썸네일 없음(content_type 결속)");
  check(profilePostThumbnail(post({ content_type: "photo" })) === null, "미디어 없는 사진글은 썸네일 없음");
}

// ── 브라우저 축 준비 ─────────────────────────────────────────────────────────
if (!chromiumAvailable()) {
  if (REQUIRE_BROWSER) {
    console.error("FAIL: playwright chromium 사용 불가(fail-closed)");
    rmSync(GEN, { recursive: true, force: true });
    process.exit(1);
  }
  console.log("\nSKIP: chromium 없음 — dom 축 생략(source+pure 축은 위에서 실행됨)");
  rmSync(GEN, { recursive: true, force: true });
  finish();
}

const SHOT = resolve(ROOT, "tmp/qa-screenshots");
mkdirSync(SHOT, { recursive: true });

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * fixture 45건. 페이지 경계(20/40)를 두 번 넘겨야 커서가 계속 이어지는지 볼 수 있다.
 *
 * 무대 배치 — mutation 이 관측 가능하려면 각 결함이 드러나는 행이 실제로 있어야 한다:
 *   n=3   제목 없는 일반글, 한 줄 본문       → 본문 폴백
 *   n=7   제목 없는 일반글, 선행 빈 줄+여러 줄 → 첫 줄만
 *   n=9   제목 있는 **일반글 + 이미지**      → content_type 결속(썸네일 나오면 안 됨)
 *   n=10  사진글 + 공백 URL                  → 깨진 상자 방지
 *   n=13  제목 없는 일반글, 660자 한 줄      → 80자 클램프
 *   n=15  사진글 + 영상만                    → 영상 플레이스홀더(전수 161건 축)
 *   n=20,21,22  동일 created_at 3건          → **페이지 경계를 가로지르는** 동률 구간
 */
const TOTAL = 45;
const ONE_LINE_POST = 3;
const MULTILINE_POST = 7;
const GENERAL_WITH_IMAGE = 9;
const BLANK_URL_POST = 10;
const LONG_LINE_POST = 13;
const VIDEO_ONLY_POST = 15;
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
  // 최신이 n=1 이 되도록 엄격한 내림차순. 동률 3건은 그룹 첫 시각을 공유해 경계를 가로지른다.
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

// ── stub: supabase 쿼리 빌더 계약을 흉내내고 메모리 테이블에 실제로 적용 ──────
// 이래야 컴포넌트가 스스로 만든 쿼리(커서 필터/정렬/limit/range)가 그대로 평가된다.
writeFileSync(resolve(GEN, "stub-client.js"), `
// 시드는 addInitScript 로 window 에 먼저 심긴다. 모듈 스코프 상태는 로드마다 새로
// 만들어지므로 **초기화 시점에 window 에서 읽어야** 한다.
const seed = (typeof window !== "undefined" && window.__QA_SEED__) || {};
const state = {
  posts: seed.rows ? seed.rows.slice() : [],
  profile: seed.profile ?? null,
  failNext: Boolean(seed.failFirst),
};
if (typeof window !== "undefined") window.__QA_DB__ = state;

function splitTop(expr) {
  const parts = []; let depth = 0, buf = "";
  for (const ch of expr) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { parts.push(buf); buf = ""; continue; }
    buf += ch;
  }
  if (buf) parts.push(buf);
  return parts;
}
function matchesClause(row, clause) {
  if (clause.startsWith("and(")) return splitTop(clause.slice(4, -1)).every((sub) => matchesClause(row, sub));
  const m = clause.match(/^([a-z_]+)\\.(lt|gt|eq|lte|gte)\\.(.*)$/);
  if (!m) return false;
  const [, col, op, raw] = m;
  let value = raw;
  if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value);
  const isText = col === "created_at";
  const a = isText ? String(row[col]) : Number(row[col]);
  const b = isText ? String(value) : Number(value);
  if (op === "lt") return a < b;
  if (op === "gt") return a > b;
  if (op === "eq") return a === b;
  if (op === "lte") return a <= b;
  if (op === "gte") return a >= b;
  return false;
}

function builder(table) {
  const spec = { table, filters: [], orders: [], limit: null, range: null, or: null, head: false };
  const api = {
    select(_cols, opts) { spec.head = Boolean(opts && opts.head); return api; },
    eq(col, value) { spec.filters.push({ col, value }); return api; },
    or(expr) { spec.or = expr; return api; },
    gte(col, value) { spec.filters.push({ col, value, op: "gte" }); return api; },
    order(col, opts) { spec.orders.push({ col, asc: !(opts && opts.ascending === false) }); return api; },
    limit(n) { spec.limit = n; return api.__run(); },
    range(from, to) { spec.range = [from, to]; return api.__run(); },
    maybeSingle() { return api.__run(true); },
    then(onOk, onErr) { return api.__run().then(onOk, onErr); },
    __run(single) {
      if (table === "profiles") return Promise.resolve({ data: state.profile, error: null });
      if (table === "user_badges") return Promise.resolve({ data: [], error: null });
      if (table !== "posts") return Promise.resolve({ data: single ? null : [], error: null });
      // 결함 주입은 **목록 조회에만** 건다. 헤더 카운트(head:true)나 like_count 합산이
      // 먼저 소비하면 정작 목록은 정상 응답을 받아 실패 시나리오가 성립하지 않는다.
      const isList = !spec.head && (spec.limit != null || spec.range != null);
      if (state.failNext && isList) {
        state.failNext = false;
        return Promise.resolve({ data: null, error: { message: "qa-injected" } });
      }
      let rows = state.posts.slice();
      for (const f of spec.filters) {
        if (f.op === "gte") { rows = rows.filter((r) => Number(r[f.col] ?? 0) >= Number(f.value)); continue; }
        if (f.col === "author_id") continue; // fixture 는 단일 작성자
        rows = rows.filter((r) => r[f.col] === f.value);
      }
      if (spec.or) rows = rows.filter((r) => splitTop(spec.or).some((c) => matchesClause(r, c)));
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
writeFileSync(resolve(GEN, "stub-navigation.js"), `
export const useParams = () => ({ userId: window.__QA_TARGET_ID__ });
export const useRouter = () => ({ push: (href) => { window.__QA_NAV__ = href; }, back: () => {}, replace: () => {} });
export const usePathname = () => "/profile/qa";
export const useSearchParams = () => new URLSearchParams();
`);
writeFileSync(resolve(GEN, "stub-null.jsx"), `export default function Stub(){ return null; }\n`);
writeFileSync(resolve(GEN, "entry.jsx"), `import React from "react";
import { createRoot } from "react-dom/client";
import ProfilePage from "@/qa/ProfilePage";
createRoot(document.getElementById("root")).render(React.createElement(ProfilePage));
`);

const alias = {
  "@/qa/ProfilePage": artifacts.get(PAGE_PATH),
  "@/components/profile/CommunityProfilePostRow": artifacts.get(ROW_PATH),
  "@/lib/utils/profile-posts-page": artifacts.get(PURE_PATH),
  "@/lib/utils/profile-post-preview": artifacts.get(PREVIEW_PATH),
  "@/lib/supabase/client": resolve(GEN, "stub-client.js"),
  "@/lib/supabase/AuthContext": resolve(GEN, "stub-auth.jsx"),
  "@/components/ThemeProvider": resolve(GEN, "stub-theme.jsx"),
  "next/navigation": resolve(GEN, "stub-navigation.js"),
  "@/components/ui/HeaderProfileLink": resolve(GEN, "stub-null.jsx"),
  "@/components/ui/DMButton": resolve(GEN, "stub-null.jsx"),
  "@/components/profile/InviteTab": resolve(GEN, "stub-null.jsx"),
  "@/components/profile/BadgeDetailModal": resolve(GEN, "stub-null.jsx"),
  "@/components/profile/BadgesTab": resolve(GEN, "stub-null.jsx"),
};

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
  if (req.url.split("?")[0] === "/bundle.js") {
    return res.writeHead(200, { "content-type": "text/javascript" }).end(bundleJs);
  }
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
  finish();
}

const TARGET_ID = "qa-author";

/**
 * 시나리오 하나를 **완전히 격리된 새 context/page** 에서 연다(삼순 NO-GO 1건째).
 *
 * 이전 판본은 같은 page 에 `addInitScript` 를 계속 누적했다. Playwright 는 다중 init
 * script 의 실행 순서를 보장하지 않으므로 이전 시나리오의 seed 가 최신 것을 덮을 수 있고,
 * 그러면 게이트가 조용히 엉뚱한 데이터를 검증한다(false-green/flake).
 * 이제 시나리오마다 context 를 새로 만들고 끝나면 닫는다 — seed 는 항상 정확히 하나다.
 */
async function openScenario({ posts, showPosts = true, viewerId = null, failFirst = false }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  const profile = {
    id: TARGET_ID, nickname: "QA작성자", team_id: 1, grade: "브론즈", level: 1,
    points: 0, bio: "", is_founder: false, invite_count: 0, show_posts: showPosts,
    total_posts: posts.length, total_comments: 0, total_likes_received: 0,
    joined_at: "2026-01-01T00:00:00+00:00", favorite_players: [],
  };
  await page.addInitScript(([rows, prof, target, viewer, fail]) => {
    window.__QA_TARGET_ID__ = target;
    window.__QA_USER__ = viewer ? { id: viewer } : null;
    window.__QA_SEED__ = { rows, profile: prof, failFirst: fail };
  }, [posts, profile, TARGET_ID, viewerId, failFirst]);
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
  await page.waitForFunction(() => !/로딩 중/.test(document.body.innerText), null, { timeout: 8000 });
  // 글 탭으로 전환. 탭 라벨은 "📝 글" 고정이라 exact 텍스트로 특정한다.
  await page.waitForSelector("button", { timeout: 8000 });
  const clicked = await page.evaluate(() => {
    const tab = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "📝 글");
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
  return { ctx, page };
}

const read = (page) => page.evaluate(() => ({
  rows: document.querySelectorAll("[data-community-profile-post-row]").length,
  hasMore: document.querySelector("[data-profile-posts-load-more]") != null,
  loadFailed: document.querySelector("[data-profile-posts-load-failed]") != null,
  hrefs: [...document.querySelectorAll("[data-community-profile-post-row]")].map(r => r.getAttribute("data-post-href")),
  previews: [...document.querySelectorAll("[data-community-profile-post-row]")]
    .map(r => r.querySelector("[data-profile-post-preview]")?.textContent ?? null),
  bodyText: document.body.innerText,
  overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
}));

/** 더보기를 끝까지 눌러 도달 개수를 센다. 제자리걸음이면 stalled 로 끊는다. */
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
    if (after.rows === before.rows && after.hasMore) return { clicks, state: after, stalled: true };
  }
}

const idOf = (n) => 10_000 - n;
const hrefOf = (n) => `/community/teams/1/posts/${idOf(n)}`;
const indexOfPost = (state, n) => state.hrefs.indexOf(hrefOf(n));
const previewOf = (state, n) => {
  const i = indexOfPost(state, n);
  return i < 0 ? undefined : state.previews[i];
};
const thumbKind = (page, n) => page.evaluate((href) => {
  const row = [...document.querySelectorAll("[data-community-profile-post-row]")]
    .find(r => r.getAttribute("data-post-href") === href);
  if (!row) return "ROW_MISSING";
  return row.querySelector("[data-profile-post-thumbnail]")?.getAttribute("data-profile-post-thumbnail") ?? null;
}, hrefOf(n));

try {
  // ── [B] 1페이지 + 미리보기/썸네일 ────────────────────────────────────────
  section = "B";
  console.log("\n[B] 1페이지 렌더 (실제 ProfilePage 마운트)");
  {
    const { ctx, page } = await openScenario({ posts: POSTS });
    const p1 = await read(page);
    await page.screenshot({ path: resolve(SHOT, "profile-posts-page1.png"), fullPage: true });

    check(p1.rows === PROFILE_POSTS_PAGE_SIZE, `1페이지 ${PROFILE_POSTS_PAGE_SIZE}행 (got ${p1.rows})`);
    check(p1.hasMore, `총 ${TOTAL}건이므로 더보기 노출`);
    check(!p1.loadFailed, "조회 실패 표시 없음");
    check(p1.overflowX <= 0, `가로 overflow 0 (delta=${p1.overflowX})`);

    check(indexOfPost(p1, GENERAL_WITH_IMAGE) >= 0, "일반글+이미지 행이 1페이지에 있다(무대 확인)");
    check(await thumbKind(page, GENERAL_WITH_IMAGE) === null, "이미지 달린 일반글엔 썸네일 없음");
    check(await thumbKind(page, 5) === "image", "사진글엔 이미지 썸네일");
    check(await thumbKind(page, VIDEO_ONLY_POST) === "video", "이미지 없는 영상 사진글은 영상 플레이스홀더");
    check(await thumbKind(page, BLANK_URL_POST) === null, "공백 URL 사진글은 썸네일 없음");
    check(previewOf(p1, VIDEO_ONLY_POST) === "영상", `영상글 미리보기 문구 (got ${JSON.stringify(previewOf(p1, VIDEO_ONLY_POST))})`);

    const blankBroken = await page.evaluate(() =>
      [...document.querySelectorAll('[data-profile-post-thumbnail="image"]')]
        .some(img => (img.getAttribute("src") ?? "").trim().length === 0));
    check(!blankBroken, "빈/공백 src 이미지 썸네일 없음");

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
    await ctx.close();
  }

  // ── [C] 끝까지 도달 ──────────────────────────────────────────────────────
  section = "C";
  console.log("\n[C] 더보기로 전체 도달");
  {
    const { ctx, page } = await openScenario({ posts: POSTS });
    const ex = await exhaust(page);
    await page.screenshot({ path: resolve(SHOT, "profile-posts-exhausted.png"), fullPage: true });
    check(!ex.stalled, `더보기가 제자리걸음 없이 끝까지 진행 (clicks=${ex.clicks})`);
    check(ex.state.rows === TOTAL, `전체 ${TOTAL}건 도달 (got ${ex.state.rows})`);
    check(!ex.state.hasMore, "끝에서 더보기 사라짐");
    check(indexOfPost(ex.state, PROFILE_POSTS_PAGE_SIZE + 1) >= 0, "21번째 글이 실제로 화면에 있다");
    check(indexOfPost(ex.state, TOTAL) >= 0, `마지막 ${TOTAL}번째 글도 도달`);
    for (const n of TIE_POSTS) {
      check(indexOfPost(ex.state, n) >= 0, `동일 시각 글 n=${n} 누락 없음(페이지 경계 가로지름)`);
    }
    check(new Set(ex.state.hrefs).size === ex.state.hrefs.length, "중복 행 없음");
    await ctx.close();
  }

  // ── [D] 조회 중 새 글 삽입 ───────────────────────────────────────────────
  section = "D";
  console.log("\n[D] 1페이지 조회 후 새 글 삽입 → 이어보기");
  {
    const { ctx, page } = await openScenario({ posts: POSTS });
    const before = await read(page);
    check(before.rows === PROFILE_POSTS_PAGE_SIZE, "삽입 전 1페이지 정상");
    await page.evaluate(() => {
      window.__QA_DB__.posts = [{
        id: 99_999, title: "삽입된 새 글", content: "", board_type: "team", board_id: "1",
        content_type: "general", image_urls: [], video_urls: [], like_count: 0, comment_count: 0,
        created_at: "2026-12-31T00:00:00.000Z", team_tags: ["lg"], player_tags: [],
      }, ...window.__QA_DB__.posts];
    });
    const ex = await exhaust(page);
    check(!ex.stalled, `삽입 후에도 더보기가 진행됨 (clicks=${ex.clicks})`);
    check(ex.state.rows === TOTAL, `삽입 후에도 원래 ${TOTAL}건 전부 도달 (got ${ex.state.rows})`);
    check(indexOfPost(ex.state, TOTAL) >= 0, "삽입 후에도 마지막 글 도달");
    await ctx.close();
  }

  // ── [E] 조회 중 경계 글 삭제 ─────────────────────────────────────────────
  section = "E";
  console.log("\n[E] 1페이지 조회 후 글 삭제 → 건너뜀 없음");
  {
    const { ctx, page } = await openScenario({ posts: POSTS });
    await page.evaluate((removeId) => {
      window.__QA_DB__.posts = window.__QA_DB__.posts.filter((r) => r.id !== removeId);
    }, idOf(2));
    const ex = await exhaust(page);
    check(!ex.stalled, "삭제 후에도 더보기가 진행됨");
    check(indexOfPost(ex.state, PROFILE_POSTS_PAGE_SIZE + 1) >= 0, "삭제 후에도 경계 글(21번째) 누락 없음");
    check(indexOfPost(ex.state, TOTAL) >= 0, "삭제 후에도 마지막 글 도달");
    await ctx.close();
  }

  // ── [F] 공개범위 ─────────────────────────────────────────────────────────
  section = "F";
  console.log("\n[F] 비공개 프로필");
  {
    const own = await openScenario({ posts: POSTS, showPosts: false, viewerId: TARGET_ID });
    const ownState = await read(own.page);
    check(ownState.rows === PROFILE_POSTS_PAGE_SIZE,
      `비공개여도 본인은 자기 글을 본다 (got ${ownState.rows})`);
    await own.ctx.close();

    const other = await openScenario({ posts: POSTS, showPosts: false, viewerId: "someone-else" });
    const otherState = await read(other.page);
    check(otherState.rows === 0, `비공개 프로필은 타인에게 글 0행 (got ${otherState.rows})`);
    check(/비공개 프로필/.test(otherState.bodyText), "타인에겐 비공개 안내 노출");
    await other.ctx.close();
  }

  // ── [G] 조회 실패는 "글 없음"이 아니다 ───────────────────────────────────
  section = "G";
  console.log("\n[G] 조회 실패 구분");
  {
    const { ctx, page } = await openScenario({ posts: POSTS, failFirst: true });
    const failed = await read(page);
    check(failed.rows === 0, "조회 실패 시 행 0");
    check(failed.loadFailed, "조회 실패는 전용 안내로 구분");
    check(!/아직 작성한 글이 없어요/.test(failed.bodyText), "실패를 ‘글 없음’으로 오도하지 않음");
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}

finish();
