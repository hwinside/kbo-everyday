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
 *  H4. 쿼리 배선 — created_at ≥ 창 시작, 보드 필터, popularity desc → id desc 정렬, 숨김 제외,
 *      **페이지당 조회 1회·limit want+1·hasMore = 확인행 존재**(설계 A, 하린아빠 2026-09-05 15:16 선택).
 *      응답 세대 보호(genRef)·오류 throw(커서 보존)·세대별 더보기 잠금(삼순 2·3차).
 *  H5. 홈 섹션 배선 — CommunityLatestPosts 가 useHomePopularFeed 를 쓰고, '접기'가 없으며
 *      hasMore 일 때만 '15개 더 보기' 를 그리고, 하단 링크 문구는 '커뮤니티 최신글 보기'(경로 동일).
 *  H6. 마이그레이션 — popularity 는 coalesce(like,0)+coalesce(comment,0) STORED 생성 컬럼.
 *  H7. 최애팀 **단독** 공개만(하린아빠 2026-09-05 추가 스펙) — 노출 조건은 **전부 서버 필터**:
 *      team_tags = [최애팀](jsonb eq) AND player_tags ⊆ 최애팀 로스터 태그(jsonb cd) AND author_id not.in(차단)
 *      AND id not.in(화면 id, 더보기). 클라이언트에서 걸러내는 행이 없다 → 부분 채움·보충 조회 없음.
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

const { popularCursorFilter, popularWindowStart, cursorOf, POPULAR_WINDOW_DAYS, teamOnlyTagsValue, teamOnlyPlayerTagsValue, notInListValue } =
  await import("../../" + HOOK);
const { kboIdsForTeamSlug, teamIdForKboId } = await import("../../src/lib/utils/player-roster");
const { resolvePostScope } = await import("../../src/lib/utils/post-scope");

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
check("H2-start", popularWindowStart(NOW) === "2026-08-29T04:30:00.000Z", `→ ${popularWindowStart(NOW)}`);

console.log("── H3 마이그레이션 전 행 fallback");
check("H3-fallback", cursorOf({ id: 9, like_count: 2, comment_count: 3 }).popularity === 5, "like+comment 합이 아니다");
check("H3-column", cursorOf({ id: 9, like_count: 2, comment_count: 3, popularity: 11 }).popularity === 11, "생성 컬럼 값을 무시했다");
check("H3-null", cursorOf({ id: 9, like_count: 2, comment_count: 3, popularity: null }).popularity === 5, "popularity null 이 NaN/null 로 샜다");

console.log("── H7 최애팀 단독 서버 필터 값(순수)");
check("H7-eq-value", teamOnlyTagsValue("lg") === '["lg"]', `→ ${teamOnlyTagsValue("lg")}`);
const lgTags = JSON.parse(teamOnlyPlayerTagsValue("lg"));
const lgIds = kboIdsForTeamSlug("lg");
check("H7-cd-roster-size", Array.isArray(lgTags) && lgTags.length === lgIds.length && lgTags.length > 50, `roster=${lgIds.length} tags=${lgTags.length}`);
// kboId 는 숫자 또는 외국인 임시 id(AQ002·FP022 등 영숫자). 이름은 반드시 비어 있지 않아야 한다 — 빈 이름이면 실제 태그와 절대 일치하지 않아 유실.
check("H7-cd-format", lgTags.every((t) => /^[A-Za-z0-9]+:.+$/.test(t)), `태그 형식이 kboId:이름 이 아니다: ${JSON.stringify(lgTags.filter((t) => !/^[A-Za-z0-9]+:.+$/.test(t)))}`);
check("H7-cd-all-lg", lgTags.every((t) => teamIdForKboId(t.split(":")[0]) === 1), "LG 로스터가 아닌 kboId 가 섞였다");
check("H7-cd-contains-known", lgTags.includes("79109:오지환"), "오지환(79109) 태그가 로스터 값에 없다 — 이름 형식 불일치 의심");
check("H7-cd-excludes-other", !lgTags.includes("63123:강승호") && !lgTags.some((t) => t.startsWith("63123:")), "두산 강승호(63123)가 LG 값에 들어 있다");
check("H7-cd-unknown-slug", teamOnlyPlayerTagsValue("nope") === "[]", "미지 slug 는 빈 배열이어야 한다");
// 서버 `cd` 의미를 로컬 재현(⊆)해 배지 SSOT 와 같은 판정인지 — 서버 필터 통과 ⇔ resolvePostScope 단일팀(LG).
const cdPass = (post) => JSON.stringify(post.team_tags) === teamOnlyTagsValue("lg") && (post.player_tags ?? []).every((t) => lgTags.includes(t));
const ssotLg = (post) => {
  const s = resolvePostScope(post);
  return (s.kind === "team" || s.kind === "player") && s.teamId === 1;
};
const FIXTURES = [
  { team_tags: ["lg"], player_tags: [] },
  { team_tags: ["lg"], player_tags: ["79109:오지환"] },
  { team_tags: ["lg"], player_tags: ["79109:오지환", "79365:박동원"] },
  { team_tags: ["lg"], player_tags: ["63123:강승호"] },
  { team_tags: ["lg"], player_tags: ["79109:오지환", "63123:강승호"] },
  { team_tags: ["lg", "doosan"], player_tags: [] },
  { team_tags: ["doosan"], player_tags: [] },
  { team_tags: ["lg", "doosan", "kt", "ssg", "nc", "kia", "lotte", "samsung", "hanwha", "kiwoom"], player_tags: [] },
];
check("H7-server-eq-ssot", FIXTURES.every((f) => cdPass(f) === ssotLg(f)), `서버 필터와 배지 SSOT 판정 불일치: ${JSON.stringify(FIXTURES.filter((f) => cdPass(f) !== ssotLg(f)))}`);
check("H7-notin-uuid", notInListValue(["a-b", "c"]) === '("a-b","c")', `→ ${notInListValue(["a-b", "c"])}`);
check("H7-notin-ids", notInListValue([3, 1, 2]) === "(3,1,2)", `→ ${notInListValue([3, 1, 2])}`);

console.log("── H4 쿼리 배선(소스)");
const hook = readStripped(HOOK);
check("H4-window", /\.gte\("created_at",\s*windowStartRef\.current\)/.test(hook), "created_at ≥ 창 시작 필터 없음");
check("H4-window-fixed", /windowStartRef\s*=\s*useRef/.test(hook), "창 시작이 ref 로 고정되지 않음");
check(
  "H4-team-only",
  /\.filter\("team_tags",\s*"eq",\s*teamOnlyTagsValue\(board\.teamId\)\)\s*\.filter\("player_tags",\s*"cd",\s*teamOnlyPlayerTagsValue\(board\.teamId\)\)/.test(hook),
  "팀 보드가 team_tags eq [최애팀] + player_tags cd 로스터 서버 필터가 아니다",
);
check("H4-team-only-branch", /if \(board\.kind === "team"\) \{[\s\S]*?\} else \{\s*query = applyBoardFilter\(query, board\);/.test(hook), "팀 보드에 포함(cs) 필터 applyBoardFilter 가 쓰인다");
check("H4-blocked-server", /if \(blocked\.length\) query = query\.not\("author_id",\s*"in",\s*notInListValue\(blocked\)\)/.test(hook), "차단 작성자가 서버 not.in 으로 걸러지지 않는다");
check("H4-seen-server", /if \(seenIds\.length\) query = query\.not\("id",\s*"in",\s*notInListValue\(seenIds\)\)/.test(hook), "화면 id 가 서버 not.in 으로 걸러지지 않는다(재등장 중복)");
check("H4-no-client-filter", !/\.filter\(\(p\)\s*=>/.test(hook) && !/isTeamOnlyPost|fillVisible|MAX_FILL_BATCHES/.test(hook), "클라이언트 필터/보충 루프가 남아 있다(설계 A 위반: 부분 채움)");
check("H4-limit-peek", /\.limit\(want \+ 1\)/.test(hook), "limit 이 want+1(확인행)이 아니다");
check("H4-hasmore-peek", /return \{ rows: fetched\.slice\(0, want\), hasMore: fetched\.length > want \};/.test(hook), "hasMore 가 확인행 존재(fetched.length > want)가 아니다");
check("H4-hasmore-wired", (hook.match(/setHasMore\(page\.hasMore\)/g) ?? []).length === 2, "첫 페이지·더보기 hasMore 가 page.hasMore 로 배선되지 않았다");
check("H4-more-seen-ids", /fetchPage\(cursorRef\.current,\s*stepSize,\s*posts\.map\(\(p\) => p\.id\)\)/.test(hook), "더보기가 화면 id 를 서버 제외 목록으로 넘기지 않는다");
check("H4-first-no-seen", /fetchPage\(null,\s*initialSize,\s*\[\]\)/.test(hook), "첫 페이지 호출 형태가 다르다");
check("H4-hidden", /\.neq\("is_hidden",\s*true\)/.test(hook), "숨김 글 제외 없음");
check(
  "H4-order",
  /\.order\("popularity",\s*\{\s*ascending:\s*false\s*\}\)\s*\.order\("id",\s*\{\s*ascending:\s*false\s*\}\)/.test(hook),
  "popularity desc → id desc 정렬이 아니다",
);
check("H4-cursor", /query\.or\(popularCursorFilter\(cursor\)\)/.test(hook), "커서 조건이 쿼리에 안 실린다");
check("H4-error-throw", /if\s*\(error\)\s*throw\s+error/.test(hook), "조회 오류를 throw 하지 않는다(오류가 소진으로 오판된다)");
check("H4-gen-first", /const gen = \+\+genRef\.current/.test(hook) && (hook.match(/if \(gen !== genRef\.current\) return/g) ?? []).length >= 3, "첫 페이지 응답 세대 보호(genRef) 없음");
check("H4-gen-more", /const gen = genRef\.current;[\s\S]*?fetchPage\(cursorRef\.current[\s\S]*?if \(gen !== genRef\.current\) return/.test(hook), "더보기 응답 세대 보호 없음");
check("H4-gen-unmount", /const gen = genRef;[\s\S]*?return \(\) => \{\s*gen\.current\+\+;\s*\}/.test(hook), "언마운트·키 교체 시 세대를 올리지 않는다");
check("H4-blocked-refill", /\[loadFirst,\s*blockedSig\]/.test(hook), "차단 목록 변경 시 첫 페이지를 다시 읽지 않는다");
check("H4-more-lock-gen", /finally\s*\{[\s\S]*?if \(gen === genRef\.current\) \{\s*fetchingRef\.current = false;\s*setLoadingMore\(false\);/.test(hook), "옛 더보기 finally 가 세대 확인 없이 잠금을 건드린다(삼순 3차 ②)");
check("H4-reload-unlock", /const gen = \+\+genRef\.current;[\s\S]{0,400}?fetchingRef\.current = false;\s*setLoadingMore\(false\);\s*setLoading\(true\);/.test(hook), "새 세대(loadFirst)가 옛 더보기 잠금을 풀지 않는다(삼순 3차 ②)");

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
    ["S7-team-cs", HOOK, '.filter("team_tags", "eq", teamOnlyTagsValue(board.teamId))\n          .filter("player_tags", "cd", teamOnlyPlayerTagsValue(board.teamId));', ".filter(\"team_tags\", \"cs\", teamOnlyTagsValue(board.teamId));", "최애팀 포함(cs) 필터로 회귀 → 전체구단 공개 글 재노출"],
    ["S8-drop-player-cd", HOOK, '\n          .filter("player_tags", "cd", teamOnlyPlayerTagsValue(board.teamId))', "", "선수 태그 로스터 필터 제거 → 타팀 선수 태그 섞인 글 노출"],
    ["S9-error-as-empty", HOOK, "if (error) throw error;", "if (error) return { rows: [], hasMore: false };", "조회 오류를 소진으로 처리 → 재시도 불가"],
    ["S10-no-peek", HOOK, ".limit(want + 1)", ".limit(want)", "확인행 없음 → 정확 5·20건에서 버튼 잔존"],
    ["S11-hasmore-ge", HOOK, "hasMore: fetched.length > want", "hasMore: fetched.length >= want", "확인행 없이 hasMore → 빈 더보기 클릭"],
    ["S12-more-no-gen", HOOK, "if (gen !== genRef.current) return; // 팀 전환·새로고침이 끼어들었다", "if (false) return; // 팀 전환·새로고침이 끼어들었다", "더보기 응답 세대 보호 제거 → 옛 응답이 새 목록 오염"],
    ["S13-drop-blocked", HOOK, 'if (blocked.length) query = query.not("author_id", "in", notInListValue(blocked));', "", "차단 작성자 서버 필터 제거"],
    ["S14-drop-seen", HOOK, 'if (seenIds.length) query = query.not("id", "in", notInListValue(seenIds));', "", "재등장 글 서버 제외 제거 → 중복 행"],
    ["S15-roster-other-team", HOOK, 'kboIdsForTeamSlug(slug).map(', 'kboIdsForTeamSlug(slug === "lg" ? "doosan" : slug).map(', "로스터 값이 타팀으로 → 서버 필터가 SSOT 와 어긋남"],
    ["S16-old-gen-unlocks", HOOK, "if (gen === genRef.current) {\n        fetchingRef.current = false;", "if (true) {\n        fetchingRef.current = false;", "옛 더보기 finally 가 새 세대 잠금을 건드림"],
    ["S17-reload-keeps-lock", HOOK, "fetchingRef.current = false;\n    setLoadingMore(false);\n    setLoading(true);", "setLoading(true);", "reload 가 옛 더보기 잠금을 풀지 않음 → 새 세대 버튼 비활성"],
    ["S18-client-filter-back", HOOK, "const fetched = (data ?? []).map((r) => mapFeedRow(r as Record<string, unknown>));", "const fetched = (data ?? []).map((r) => mapFeedRow(r as Record<string, unknown>)).filter((p) => p.id > 0);", "클라이언트 필터 부활 → 부분 채움 회귀(설계 A 위반)"],
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
