#!/usr/bin/env node
/**
 * home-popular-feed-gate (npm run qa:home-popular-feed / :selftest)
 *
 * 계약 (2026-09-05 #product 하린아빠 스펙 — 홈 커뮤니티 파트를 '최신글' → '최근 7일 인기글'로):
 *
 *  H1. 인기도 keyset 커서 = (popularity desc, id desc). 커서 다음 조건은
 *      `popularity < c OR (popularity = c AND id < cid)` 한 가지 문자열로만 만들어진다.
 *  H2. 집계 창은 정확히 7일(now - 7d). 창 시작은 훅이 페이지 사이에 고정한다(소스 검사).
 *  H3. 마이그레이션 전 행(popularity 부재)은 like_count+comment_count 로 커서를 만든다(무너지지 않음).
 *  H4. 쿼리 배선 — created_at ≥ 창 시작, 보드 필터, popularity desc → id desc 정렬, 숨김 제외.
 *  H5. 홈 섹션 배선 — CommunityLatestPosts 가 useHomePopularFeed 를 쓰고, '접기'가 없으며
 *      hasMore 일 때만 '15개 더 보기' 를 그리고, 하단 링크 문구는 '커뮤니티 최신글 보기'(경로 동일).
 *  H6. 마이그레이션 — popularity 는 coalesce(like,0)+coalesce(comment,0) STORED 생성 컬럼.
 *  H7. 최애팀 **단독** 공개만(하린아빠 2026-09-05 추가 스펙) — 팀 보드는 team_tags = [최애팀] jsonb eq 로
 *      서버 필터하고(포함 cs 필터 금지), 배지 SSOT(resolvePostScope)로 단일팀=최애팀을 재확인한다.
 *      hasMore/커서는 서버가 돌려준 행 수 기준(재확인으로 빠진 행이 있어도 keyset 전진).
 *
 * 순수 함수는 직접 실행하고 배선만 소스 검사한다. 소스 검사 구간은 주석을 blank 처리해
 * "주석이 assertion 을 만족시키는" false-green 을 차단한다.
 * --selftest: 실제 소스 변이로 RED 를 증명한다(자식 프로세스 재실행).
 */
import "./_smoke-env";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SELFTEST = process.argv.includes("--selftest");

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "));
}
function readStripped(rel) {
  return stripComments(readFileSync(path.join(ROOT, rel), "utf8"));
}

const failures = [];
function check(id, ok, detail) {
  if (ok) console.log(`  PASS  ${id}`);
  else {
    failures.push(`${id}: ${detail}`);
    console.error(`  ❌ FAIL  ${id} — ${detail}`);
  }
}

const HOOK = "src/lib/supabase/useHomePopularFeed.ts";
const SECTION = "src/components/home/CommunityLatestPosts.tsx";
const MIGRATION = "supabase/migrations/20260905043000_posts_popularity.sql";

const { popularCursorFilter, popularWindowStart, cursorOf, POPULAR_WINDOW_DAYS, teamOnlyTagsValue, isTeamOnlyPost } = await import(
  "../../" + HOOK
);

console.log("── H1 keyset 커서 조건");
check(
  "H1-filter",
  popularCursorFilter({ popularity: 7, id: 1234 }) === "popularity.lt.7,and(popularity.eq.7,id.lt.1234)",
  `→ ${popularCursorFilter({ popularity: 7, id: 1234 })}`,
);
check("H1-zero", popularCursorFilter({ popularity: 0, id: 5 }) === "popularity.lt.0,and(popularity.eq.0,id.lt.5)", "인기도 0 커서");

console.log("── H2 7일 창");
const NOW = Date.UTC(2026, 8, 5, 4, 30, 0);
check("H2-days", POPULAR_WINDOW_DAYS === 7, `POPULAR_WINDOW_DAYS=${POPULAR_WINDOW_DAYS}`);
check(
  "H2-start",
  popularWindowStart(NOW) === "2026-08-29T04:30:00.000Z",
  `→ ${popularWindowStart(NOW)}`,
);

console.log("── H3 마이그레이션 전 행 fallback");
check("H3-fallback", cursorOf({ id: 9, like_count: 2, comment_count: 3 }).popularity === 5, "like+comment 합이 아니다");
check("H3-column", cursorOf({ id: 9, like_count: 2, comment_count: 3, popularity: 11 }).popularity === 11, "생성 컬럼 값을 무시했다");
check("H3-null", cursorOf({ id: 9, like_count: 2, comment_count: 3, popularity: null }).popularity === 5, "popularity null 이 NaN/null 로 샜다");

console.log("── H7 최애팀 단독 공개 판정(순수)");
check("H7-eq-value", teamOnlyTagsValue("lg") === '["lg"]', `→ ${teamOnlyTagsValue("lg")}`);
// LG(id 1) 기준. 배지 SSOT(resolvePostScope)와 같은 판정이어야 한다.
const LG = 1;
check("H7-only", isTeamOnlyPost({ id: 1, team_tags: ["lg"], player_tags: [] }, LG) === true, "[lg] 단독이 통과하지 않는다");
check("H7-only-player", isTeamOnlyPost({ id: 1, team_tags: ["lg"], player_tags: ["79109:오지환"] }, LG) === true, "[lg]+LG 선수 태그가 통과하지 않는다");
check("H7-multi", isTeamOnlyPost({ id: 1, team_tags: ["lg", "doosan"], player_tags: [] }, LG) === false, "다팀(최애팀 포함)이 통과했다");
check("H7-all", isTeamOnlyPost({ id: 1, team_tags: ["lg", "doosan", "kt", "ssg", "nc", "kia", "lotte", "samsung", "hanwha", "kiwoom"], player_tags: [] }, LG) === false, "전체구단 공개가 통과했다");
check("H7-other-team", isTeamOnlyPost({ id: 1, team_tags: ["doosan"], player_tags: [] }, LG) === false, "다른 팀 단독이 통과했다");
check("H7-empty", isTeamOnlyPost({ id: 1, team_tags: [], player_tags: [] }, LG) === false, "무태그(전체구단 개념)가 통과했다");

console.log("── H4 쿼리 배선(소스)");
const hook = readStripped(HOOK);
check("H4-window", /\.gte\("created_at",\s*windowStartRef\.current\)/.test(hook), "created_at ≥ 창 시작 필터 없음");
check("H4-window-fixed", /windowStartRef\s*=\s*useRef/.test(hook), "창 시작이 ref 로 고정되지 않음");
check(
  "H4-team-only",
  /board\.kind\s*===\s*"team"\s*\?\s*query\.filter\("team_tags",\s*"eq",\s*teamOnlyTagsValue\(board\.teamId\)\)\s*:\s*applyBoardFilter\(query,\s*board\)/.test(hook),
  "팀 보드가 team_tags = [최애팀] 단독 필터가 아니다(포함 필터 applyBoardFilter 로 회귀)",
);
check("H4-team-only-client", /all\.filter\(\(p\)\s*=>\s*isTeamOnlyPost\(p,\s*teamOnlyId\)\)/.test(hook), "배지 SSOT 재확인(isTeamOnlyPost) 미적용");
check("H4-hasmore-fetched", /setHasMore\(page\.fetched\s*===\s*initialSize\)/.test(hook) && /setHasMore\(page\.fetched\s*===\s*stepSize\)/.test(hook), "hasMore 가 서버 행 수(fetched)가 아니라 필터 후 행 수로 판정된다");
check("H4-hidden", /\.neq\("is_hidden",\s*true\)/.test(hook), "숨김 글 제외 없음");
check(
  "H4-order",
  /\.order\("popularity",\s*\{\s*ascending:\s*false\s*\}\)\s*\.order\("id",\s*\{\s*ascending:\s*false\s*\}\)/.test(hook),
  "popularity desc → id desc 정렬이 아니다",
);
check("H4-cursor", /query\.or\(popularCursorFilter\(cursor\)\)/.test(hook), "커서 조건이 쿼리에 안 실린다");

console.log("── H5 홈 섹션 배선(소스)");
const section = readStripped(SECTION);
check("H5-hook", /useHomePopularFeed\(/.test(section) && !/useUnifiedFeed\(/.test(section), "홈 섹션이 인기글 훅을 쓰지 않는다");
check("H5-no-collapse", !/접기/.test(section), "'접기' 가 남아 있다(계속 이어 붙이기 스펙 위반)");
check("H5-more-gated", /\{hasMore\s*&&\s*\(/.test(section), "'더 보기' 버튼이 hasMore 로 게이트되지 않는다");
check("H5-more-load", /onClick=\{\(\)\s*=>\s*void loadMore\(\)\}/.test(section), "'더 보기' 가 loadMore 를 호출하지 않는다");
check("H5-more-label", /\{HOME_POPULAR_STEP\}개 더 보기/.test(section) && /HOME_POPULAR_STEP\s*=\s*15/.test(section), "'15개 더 보기' 문구/상수 불일치");
check("H5-link-label", /커뮤니티 최신글 보기/.test(section) && !/커뮤니티 더보기/.test(section), "하단 링크 문구가 '커뮤니티 최신글 보기' 가 아니다");
check("H5-link-href", (section.match(/href="\/community\/all-posts"/g) ?? []).length >= 2, "하단 링크 경로(/community/all-posts) 변경됨");
check("H5-title", /커뮤니티 인기글/.test(section) && !/`커뮤니티 최신글\(/.test(section), "섹션 제목이 '커뮤니티 인기글' 이 아니다");

console.log("── H6 마이그레이션");
const mig = readFileSync(path.join(ROOT, MIGRATION), "utf8").replace(/--[^\n]*/g, "");
check(
  "H6-generated",
  /popularity\s+integer\s+generated\s+always\s+as\s+\(coalesce\(like_count,\s*0\)\s*\+\s*coalesce\(comment_count,\s*0\)\)\s+stored/i.test(mig),
  "popularity 생성 컬럼 정의가 like+comment(coalesce) STORED 가 아니다",
);
check("H6-index", /on\s+public\.posts\s*\(popularity\s+desc,\s*id\s+desc\)/i.test(mig), "정렬 순서와 같은 인덱스가 없다");

if (failures.length) {
  console.error(`\n❌ home-popular-feed-gate FAIL — ${failures.length}건`);
  process.exit(1);
}
console.log("\n✅ home-popular-feed-gate PASS");

// ───────────────────────── selftest: 실제 변이로 RED 증명 ─────────────────────────
if (SELFTEST) {
  console.log("\n── selftest: 소스 변이 주입 → 자식 게이트 RED 기대");
  /** [id, 파일, 앵커, 치환, 설명] */
  const MUTATIONS = [
    ["S1-drop-window", HOOK, '.gte("created_at", windowStartRef.current)', '.gte("id", 0)', "7일 창 제거 → 전 기간 인기글"],
    ["S2-order-asc", HOOK, '.order("popularity", { ascending: false })', '.order("popularity", { ascending: true })', "인기도 오름차순 → 비인기글 우선"],
    ["S3-cursor-shape", HOOK, "and(popularity.eq.${c.popularity},id.lt.${c.id})", "id.lt.${c.id}", "동점 tie-break 붕괴 → 중복/누락"],
    ["S4-collapse-back", SECTION, "{HOME_POPULAR_STEP}개 더 보기", "접기", "'접기' 부활"],
    ["S5-link-label", SECTION, "커뮤니티 최신글 보기", "커뮤니티 더보기", "하단 링크 문구 회귀"],
    ["S6-migration-expr", MIGRATION, "coalesce(like_count, 0) + coalesce(comment_count, 0)", "coalesce(like_count, 0)", "인기도에서 댓글수 누락"],
    ["S7-team-cs", HOOK, 'query.filter("team_tags", "eq", teamOnlyTagsValue(board.teamId))', "applyBoardFilter(query, board)", "최애팀 포함(cs) 필터로 회귀 → 전체구단 공개 글 재노출"],
    ["S8-scope-multi", HOOK, 'return (scope.kind === "team" || scope.kind === "player") && scope.teamId === teamId;', "return true;", "배지 SSOT 재확인 무력화 → 타팀 선수 태그 섞인 글 노출"],
  ];
  let selftestFailed = 0;
  for (const [id, rel, anchor, replace, desc] of MUTATIONS) {
    const abs = path.join(ROOT, rel);
    const original = readFileSync(abs, "utf8");
    if (!original.includes(anchor)) {
      selftestFailed++;
      console.error(`  ❌ ${id}: 앵커 MISS — '${anchor}' 없음 (러너 결함, 즉시 수선)`);
      continue;
    }
    writeFileSync(abs, original.replace(anchor, replace), "utf8");
    try {
      execFileSync("npx", ["tsx", "scripts/qa/home-popular-feed-gate.mjs"], { cwd: ROOT, stdio: "pipe", encoding: "utf8" });
      selftestFailed++;
      console.error(`  ❌ ${id}: 결함 주입에도 GREEN — 게이트에 검출력이 없다 (${desc})`);
    } catch {
      console.log(`  PASS  ${id}: RED 확인 — ${desc}`);
    } finally {
      writeFileSync(abs, original, "utf8");
    }
  }
  if (selftestFailed > 0) {
    console.error(`\n❌ selftest FAIL — ${selftestFailed}건`);
    process.exit(1);
  }
  console.log("\n✅ selftest PASS — 전 변이에서 RED");
}
