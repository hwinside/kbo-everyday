#!/usr/bin/env node
/**
 * home-popular-feed-gate (npm run qa:home-popular-feed / :selftest)
 *
 * 계약 (2026-09-05 #product 하린아빠 스펙 — 홈 커뮤니티 파트를 '최신글' → '최근 7일 인기글'로):
 *
 *  H2. 집계 창은 정확히 7일(now - 7d). 창 시작은 훅이 페이지 사이에 고정한다(소스 검사).
 *  H4. 훅 배선 — 페이지당 `home_popular_posts` RPC 1회, `p_limit = want+1`, hasMore = 확인행 존재, 인기도 커서 없음
 *      (다음 페이지 = p_exclude 화면 id 제외), 응답 세대 보호(genRef)·진행 중 요청 abort·시간 상한·
 *      오류 throw(상태 보존)·세대별 더보기 잠금(삼순 2·3·5차). 클라이언트 필터/보충 루프 없음(설계 A).
 *  H5. 홈 섹션 배선 — CommunityLatestPosts 가 useHomePopularFeed 를 쓰고, '접기'가 없으며
 *      hasMore 일 때만 '15개 더 보기' 를 그리고, 하단 링크 문구는 '커뮤니티 최신글 보기'(경로 동일).
 *  H6. 마이그레이션 — popularity 는 coalesce(like,0)+coalesce(comment,0) STORED 생성 컬럼 + 정렬 인덱스 +
 *      home_popular_posts RPC(security invoker, ID 기준 타팀 선수 태그 제외, 제외 목록, limit 상한, anon/authenticated grant).
 *      실제 SQL 판정은 qa:home-popular-feed:pg17 이 PostgreSQL 17 에서 픽스처로 검증한다.
 *  H7. 최애팀 **단독** 공개만(하린아빠 2026-09-05 추가 스펙) — RPC 인자: p_team_slug = 최애팀,
 *      p_other_kbo_ids = **타팀 로스터 ID(거부 목록, 올스타 제외)**. 허용 목록이 아니라 거부 목록이어야 배지 SSOT
 *      (로스터 밖 ID·올스타 무시, 이름 미비교)와 같은 판정이 된다(삼순 5차 ③).
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

const { popularWindowStart, POPULAR_WINDOW_DAYS, POPULAR_FETCH_TIMEOUT_MS, otherTeamsKboIds, homePopularRpcArgs } = await import("../../" + HOOK);
const { kboIdsForTeamSlug, teamIdForKboId } = await import("../../src/lib/utils/player-roster");
const { isAllStarTeamId } = await import("../../src/lib/constants/teams");
const { resolvePostScope } = await import("../../src/lib/utils/post-scope");

console.log("── H2 7일 창·시간 상한");
const NOW = Date.UTC(2026, 8, 5, 4, 30, 0);
check("H2-days", POPULAR_WINDOW_DAYS === 7, `POPULAR_WINDOW_DAYS=${POPULAR_WINDOW_DAYS}`);
check("H2-start", popularWindowStart(NOW) === "2026-08-29T04:30:00.000Z", `→ ${popularWindowStart(NOW)}`);
check("H2-timeout", Number.isFinite(POPULAR_FETCH_TIMEOUT_MS) && POPULAR_FETCH_TIMEOUT_MS >= 3000 && POPULAR_FETCH_TIMEOUT_MS <= 30000, `timeout=${POPULAR_FETCH_TIMEOUT_MS}`);

console.log("── H7 최애팀 단독 RPC 인자(순수)");
const LG = 1;
const other = otherTeamsKboIds("lg");
const lgIds = new Set(kboIdsForTeamSlug("lg"));
check("H7-other-size", other.length > 500 && other.length < 2000, `other=${other.length}`);
check("H7-other-no-lg", other.every((id) => !lgIds.has(id)), "거부 목록에 LG 선수가 섞였다");
check("H7-other-all-known-teams", other.every((id) => { const t = teamIdForKboId(id); return t != null && t !== LG && !isAllStarTeamId(t); }), "거부 목록에 로스터 밖·올스타·LG ID 가 있다");
check("H7-other-contains-doosan", other.includes("63123"), "두산 강승호(63123)가 거부 목록에 없다");
check("H7-other-unknown-slug", otherTeamsKboIds("nope").length === 0, "미지 slug 는 빈 배열이어야 한다");
const args = homePopularRpcArgs({ kind: "team", teamId: "lg" }, "2026-08-29T04:30:00.000Z", 5, ["u1"], [3, 2]);
check("H7-args-team", args.p_team_slug === "lg" && args.p_limit === 6 && args.p_since === "2026-08-29T04:30:00.000Z" && args.p_other_kbo_ids.length === other.length && args.p_blocked.join() === "u1" && args.p_exclude.join() === "3,2", JSON.stringify({ ...args, p_other_kbo_ids: args.p_other_kbo_ids.length }));
const argsAll = homePopularRpcArgs({ kind: "all" }, "x", 15, [], []);
check("H7-args-all", argsAll.p_team_slug === null && argsAll.p_other_kbo_ids.length === 0 && argsAll.p_limit === 16 && argsAll.p_exclude.length === 0, JSON.stringify(argsAll));
// 서버 판정(거부 목록 ∩ 태그 ID = ∅)을 로컬 재현 → 배지 SSOT 와 같은 판정이어야 한다.
const serverPass = (post) => JSON.stringify(post.team_tags) === '["lg"]' && !(post.player_tags ?? []).some((t) => other.includes(String(t).split(":")[0]));
const ssotLg = (post) => { const s = resolvePostScope(post); return (s.kind === "team" || s.kind === "player") && s.teamId === LG; };
const FIXTURES = [
  { team_tags: ["lg"], player_tags: [] },
  { team_tags: ["lg"], player_tags: ["79109:오지환"] },
  { team_tags: ["lg"], player_tags: ["79109:오지환 "] },
  { team_tags: ["lg"], player_tags: ["79109:오지환", "79365:박동원"] },
  { team_tags: ["lg"], player_tags: ["ZZ999:은퇴선수"] },
  { team_tags: ["lg"], player_tags: ["63123:강승호"] },
  { team_tags: ["lg"], player_tags: ["79109:오지환", "63123:강승호"] },
  { team_tags: ["lg", "doosan"], player_tags: [] },
  { team_tags: ["doosan"], player_tags: [] },
  { team_tags: ["lg", "doosan", "kt", "ssg", "nc", "kia", "lotte", "samsung", "hanwha", "kiwoom"], player_tags: [] },
];
check("H7-server-eq-ssot", FIXTURES.every((f) => serverPass(f) === ssotLg(f)), `서버 판정과 배지 SSOT 불일치: ${JSON.stringify(FIXTURES.filter((f) => serverPass(f) !== ssotLg(f)))}`);

console.log("── H4 훅 배선(소스)");
const hook = readStripped(HOOK);
check("H4-rpc", /\.rpc\("home_popular_posts",\s*homePopularRpcArgs\(board,\s*windowStartRef\.current,\s*want,\s*Array\.from\(blockedRef\.current\),\s*exclude\)\)/.test(hook), "home_popular_posts RPC 를 homePopularRpcArgs 인자로 호출하지 않는다");
check("H4-select-popularity", /\.select\(`\$\{FEED_SELECT\}, popularity`\)/.test(hook), "RPC 결과 select 가 FEED_SELECT + popularity 가 아니다");
check("H4-abort-signal", /\.abortSignal\(controller\.signal\)/.test(hook), "요청에 AbortSignal 이 실리지 않는다");
check("H4-timeout", /const timer = setTimeout\(\(\) => controller\.abort\(\), timeoutMs\);/.test(hook) && /clearTimeout\(timer\)/.test(hook), "요청 시간 상한(timeout → abort)이 없다");
check("H4-inflight-abort", /const abortInflight = useCallback\(\(\) => \{\s*for \(const c of inflightRef\.current\) c\.abort\(\);/.test(hook), "진행 중 요청 abort 헬퍼가 없다");
check("H4-first-aborts", /const gen = \+\+genRef\.current;\s*abortInflight\(\);/.test(hook), "새 세대(loadFirst)가 진행 중 요청을 abort 하지 않는다");
check("H4-unmount-aborts", /return \(\) => \{\s*gen\.current\+\+;\s*abortInflight\(\);\s*\}/.test(hook), "언마운트·키 교체 시 abort 하지 않는다");
check("H4-window", /windowStartRef\s*=\s*useRef/.test(hook) && /windowStartRef\.current = popularWindowStart\(\)/.test(hook), "창 시작이 ref 로 고정되지 않음");
check("H4-no-cursor", !/cursor/i.test(hook), "인기도 커서가 남아 있다(순위 상승 글 누락, 삼순 5차 ①)");
check("H4-no-client-filter", !/mapFeedRow\(r\)\)\s*\.filter\(/.test(hook) && !/fetched\.filter\(|rows\.filter\(|isTeamOnlyPost|fillVisible|MAX_FILL_BATCHES/.test(hook), "클라이언트 필터/보충 루프가 남아 있다(설계 A 위반)");
check("H4-hasmore-peek", /return \{ rows: fetched\.slice\(0, want\), hasMore: fetched\.length > want \};/.test(hook), "hasMore 가 확인행 존재(fetched.length > want)가 아니다");
check("H4-hasmore-wired", (hook.match(/setHasMore\(page\.hasMore\)/g) ?? []).length === 2, "첫 페이지·더보기 hasMore 가 page.hasMore 로 배선되지 않았다");
check("H4-more-exclude", /fetchPage\(stepSize,\s*posts\.map\(\(p\) => p\.id\)\)/.test(hook), "더보기가 화면 id 를 제외 목록으로 넘기지 않는다");
check("H4-first-no-exclude", /fetchPage\(initialSize,\s*\[\]\)/.test(hook), "첫 페이지 호출 형태가 다르다");
check("H4-error-throw", /if\s*\(error\)\s*throw\s+error/.test(hook), "조회 오류를 throw 하지 않는다(오류가 소진으로 오판된다)");
check("H4-gen-first", (hook.match(/if \(gen !== genRef\.current\) return/g) ?? []).length >= 3, "첫 페이지 응답 세대 보호(genRef) 없음");
check("H4-gen-more", /const gen = genRef\.current;[\s\S]*?fetchPage\(stepSize[\s\S]*?if \(gen !== genRef\.current\) return/.test(hook), "더보기 응답 세대 보호 없음");
check("H4-blocked-refill", /\[loadFirst,\s*blockedSig,\s*abortInflight\]/.test(hook), "차단 목록 변경 시 첫 페이지를 다시 읽지 않는다");
check("H4-more-lock-gen", /finally\s*\{[\s\S]*?if \(gen === genRef\.current\) \{\s*fetchingRef\.current = false;\s*setLoadingMore\(false\);/.test(hook), "옛 더보기 finally 가 세대 확인 없이 잠금을 건드린다(삼순 3차 ②)");
check("H4-reload-unlock", /abortInflight\(\);\s*fetchingRef\.current = false;\s*setLoadingMore\(false\);\s*setLoading\(true\);/.test(hook), "새 세대(loadFirst)가 옛 더보기 잠금을 풀지 않는다(삼순 3차 ②)");

console.log("── H5 홈 섹션 배선(소스)");
const section = readStripped(SECTION);
check("H5-hook", /useHomePopularFeed\(/.test(section) && !/useUnifiedFeed\(/.test(section), "홈 섹션이 인기글 훅을 쓰지 않는다");
check("H5-board-type", /const board: HomePopularBoard = myTeamSlug \? \{ kind: "team", teamId: myTeamSlug \} : \{ kind: "all" \}/.test(section), "섹션 보드가 최애팀 단독/전체 2종이 아니다");
check("H5-no-collapse", !/접기/.test(section), "'접기' 가 남아 있다(계속 이어 붙이기 스펙 위반)");
check("H5-more-gated", /\{hasMore\s*&&\s*\(/.test(section), "'더 보기' 버튼이 hasMore 로 게이트되지 않는다");
check("H5-more-load", /onClick=\{\(\)\s*=>\s*void loadMore\(\)\}/.test(section), "'더 보기' 가 loadMore 를 호출하지 않는다");
check("H5-more-label", /\{HOME_POPULAR_STEP\}개 더 보기/.test(section) && /HOME_POPULAR_STEP\s*=\s*15/.test(section), "'15개 더 보기' 문구/상수 불일치");
check("H5-link-label", /커뮤니티 최신글 보기/.test(section) && !/커뮤니티 더보기/.test(section), "하단 링크 문구가 '커뮤니티 최신글 보기' 가 아니다");
check("H5-link-href", (section.match(/href="\/community\/all-posts"/g) ?? []).length >= 2, "하단 링크 경로(/community/all-posts) 변경됨");
check("H5-title", /커뮤니티 인기글/.test(section) && !/`커뮤니티 최신글\(/.test(section), "섹션 제목이 '커뮤니티 인기글' 이 아니다");

console.log("── H6 마이그레이션(소스)");
const mig = readFileSync(path.join(ROOT, MIGRATION), "utf8").replace(/--[^\n]*/g, "");
check("H6-generated", /popularity\s+integer\s+generated\s+always\s+as\s+\(coalesce\(like_count,\s*0\)\s*\+\s*coalesce\(comment_count,\s*0\)\)\s+stored/i.test(mig), "popularity 생성 컬럼 정의가 like+comment(coalesce) STORED 가 아니다");
check("H6-index", /on\s+public\.posts\s*\(popularity\s+desc,\s*id\s+desc\)/i.test(mig), "정렬 순서와 같은 인덱스가 없다");
check("H6-rpc-signature", /function public\.home_popular_posts\(\s*p_since timestamptz,\s*p_limit integer,\s*p_team_slug text default null,\s*p_other_kbo_ids text\[\] default '\{\}',\s*p_blocked uuid\[\] default '\{\}',\s*p_exclude bigint\[\] default '\{\}'\s*\)/i.test(mig), "RPC 시그니처가 다르다");
check("H6-rpc-invoker", /security invoker/i.test(mig) && !/security definer/i.test(mig), "RPC 가 security invoker 가 아니다(RLS 우회 위험)");
check("H6-rpc-id-judgement", /split_part\(t\.tag, ':', 1\) = any \(coalesce\(p_other_kbo_ids, '\{\}'\)\)/.test(mig), "타팀 선수 태그를 ID 기준(split_part)·거부 목록으로 판정하지 않는다");
check("H6-rpc-team-eq", /p\.team_tags = jsonb_build_array\(p_team_slug\)/.test(mig), "team_tags 가 [최애팀] 정확 일치가 아니다");
check("H6-rpc-exclude", /not \(p\.id = any \(coalesce\(p_exclude, '\{\}'\)\)\)/.test(mig) && /not \(p\.author_id = any \(coalesce\(p_blocked, '\{\}'\)\)\)/.test(mig), "제외 목록/차단 조건이 없다");
check("H6-rpc-order-limit", /order by p\.popularity desc, p\.id desc\s*limit least\(greatest\(coalesce\(p_limit, 0\), 0\), 100\);/.test(mig), "정렬/limit 상한이 다르다");
check("H6-rpc-grant", /grant execute on function public\.home_popular_posts\([^)]*\)\s*to anon, authenticated;/.test(mig), "anon/authenticated grant 가 없다");

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
    ["S1-drop-window", HOOK, "windowStartRef.current = popularWindowStart();", "windowStartRef.current = new Date(0).toISOString();", "7일 창 제거 → 전 기간 인기글"],
    ["S2-rpc-name", HOOK, '.rpc("home_popular_posts", homePopularRpcArgs(', '.rpc("home_popular_posts_v0", homePopularRpcArgs(', "다른 RPC 호출"],
    ["S3-allow-list", HOOK, "p_other_kbo_ids: board.kind === \"team\" ? otherTeamsKboIds(board.teamId) : [],", "p_other_kbo_ids: board.kind === \"team\" ? otherTeamsKboIds(board.teamId).slice(0, 10) : [],", "거부 목록 축소 → 타팀 선수 태그 글 노출(SSOT 불일치)"],
    ["S4-collapse-back", SECTION, "{HOME_POPULAR_STEP}개 더 보기", "접기", "'접기' 부활"],
    ["S5-link-label", SECTION, "커뮤니티 최신글 보기", "커뮤니티 더보기", "하단 링크 문구 회귀"],
    ["S6-migration-expr", MIGRATION, "coalesce(like_count, 0) + coalesce(comment_count, 0)", "coalesce(like_count, 0)", "인기도에서 댓글수 누락"],
    ["S7-rpc-name-match", MIGRATION, "split_part(t.tag, ':', 1) = any (coalesce(p_other_kbo_ids, '{}'))", "t.tag = any (coalesce(p_other_kbo_ids, '{}'))", "ID 가 아니라 전체 문자열 비교 → 이름 표기 차이에 SSOT 와 어긋남"],
    ["S8-rpc-definer", MIGRATION, "stable\nsecurity invoker", "stable\nsecurity definer", "RLS 우회(함수 본체의 invoker 를 definer 로 — 주석의 문구가 아니라 정의를 변이)"],
    ["S9-error-as-empty", HOOK, "if (error) throw error;", "if (error) return { rows: [], hasMore: false };", "조회 오류를 소진으로 처리 → 재시도 불가"],
    ["S10-no-peek", HOOK, "p_limit: want + 1,", "p_limit: want,", "확인행 없음 → 정확 5·20건에서 버튼 잔존"],
    ["S11-hasmore-ge", HOOK, "hasMore: fetched.length > want", "hasMore: fetched.length >= want", "확인행 없이 hasMore → 빈 더보기 클릭"],
    ["S12-more-no-gen", HOOK, "if (gen !== genRef.current) return; // 팀 전환·새로고침이 끼어들었다", "if (false) return; // 팀 전환·새로고침이 끼어들었다", "더보기 응답 세대 보호 제거 → 옛 응답이 새 목록 오염"],
    ["S13-drop-blocked-arg", HOOK, "p_blocked: [...blocked],", "p_blocked: [],", "차단 목록을 서버에 안 넘김"],
    ["S14-drop-exclude", HOOK, "fetchPage(stepSize, posts.map((p) => p.id))", "fetchPage(stepSize, [])", "화면 id 제외 없음 → 중복 행"],
    ["S15-no-abort-signal", HOOK, ".abortSignal(controller.signal)", ".abortSignal(new AbortController().signal)", "요청에 abort 신호 미연결 → 무응답 잠금"],
    ["S16-old-gen-unlocks", HOOK, "if (gen === genRef.current) {\n        fetchingRef.current = false;", "if (true) {\n        fetchingRef.current = false;", "옛 더보기 finally 가 새 세대 잠금을 건드림"],
    ["S17-reload-keeps-lock", HOOK, "    fetchingRef.current = false;\n    setLoadingMore(false);\n    setLoading(true);", "    setLoading(true);", "reload 가 옛 더보기 잠금을 풀지 않음 → 새 세대 버튼 비활성"],
    ["S18-no-timeout", HOOK, "const timer = setTimeout(() => controller.abort(), timeoutMs);", "const timer = setTimeout(() => {}, timeoutMs);", "시간 상한 제거 → 무응답 시 잠금 지속"],
    ["S19-first-no-abort", HOOK, "const gen = ++genRef.current;\n    abortInflight();", "const gen = ++genRef.current;", "새 세대가 옛 요청을 abort 하지 않음"],
    ["S20-client-filter-back", HOOK, "const fetched = ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => mapFeedRow(r));", "const fetched = ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => mapFeedRow(r)).filter((p) => p.id > 0);", "클라이언트 필터 부활 → 부분 채움 회귀(설계 A 위반)"],
    ["S21-rpc-drop-exclude", MIGRATION, "and not (p.id = any (coalesce(p_exclude, '{}')))", "", "RPC 제외 목록 무시 → 중복·순위 상승 글 처리 붕괴"],
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
