/**
 * 최애선수 선택 목록 인기순 정렬 회귀.
 *
 * 계약(하린아빠 2026-08-03 요청):
 *   PlayerSelectModal 의 팀 탭 / 전체 탭 / 검색 결과 **모두** 를
 *   "최애선수로 지정한 계정 수" 내림차순, 동률은 가나다순으로 정렬한다.
 *
 * 이 스크립트는 정렬 순수함수와 실제 모달 배선을 함께 본다.
 * 소스 문자열만 보면 "함수는 있는데 한 탭에만 연결" 같은 누락을 놓치므로,
 * 세 경로가 각각 정렬 함수를 통과하는지 확인한다.
 *
 * 실행: npm run qa:player-popularity-order
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizePopularityCounts,
  sortPlayersByPopularity,
} from "../../src/lib/utils/player-popularity";

let pass = 0;
const ok = (label: string, fn: () => void) => {
  fn();
  pass += 1;
  console.log(`  ✅ ${label}`);
};

// ── 정렬 계약 ───────────────────────────────────────────────────────────────
const players = [
  { id: "1", name: "나선수" },
  { id: "2", name: "가선수" },
  { id: "3", name: "다선수" },
  { id: "4", name: "라선수" },
];

ok("지정 계정 수 내림차순", () => {
  const sorted = sortPlayersByPopularity(players, { "3": 100, "1": 50, "2": 10 });
  assert.deepEqual(sorted.map(p => p.id), ["3", "1", "2", "4"]);
});

ok("동률은 가나다순", () => {
  const sorted = sortPlayersByPopularity(players, { "1": 5, "2": 5, "3": 5, "4": 5 });
  assert.deepEqual(sorted.map(p => p.name), ["가선수", "나선수", "다선수", "라선수"]);
});

ok("카운트 0인 선수끼리도 가나다순(순서 흔들림 금지)", () => {
  const sorted = sortPlayersByPopularity(players, {});
  assert.deepEqual(sorted.map(p => p.name), ["가선수", "나선수", "다선수", "라선수"]);
});

ok("집계 실패(빈 맵)여도 목록이 사라지지 않는다 — fail-safe", () => {
  const sorted = sortPlayersByPopularity(players, {});
  assert.equal(sorted.length, players.length);
});

ok("원본 배열을 변형하지 않는다", () => {
  const before = players.map(p => p.id);
  sortPlayersByPopularity(players, { "4": 99 });
  assert.deepEqual(players.map(p => p.id), before);
});

ok("일부만 카운트가 있어도 나머지는 뒤로 가나다순", () => {
  const sorted = sortPlayersByPopularity(players, { "4": 1 });
  assert.deepEqual(sorted.map(p => p.name), ["라선수", "가선수", "나선수", "다선수"]);
});

// ── 응답 정규화 ─────────────────────────────────────────────────────────────
ok("playerId 가 number 로 와도 string 키로 정규화", () => {
  // jsonb 에 number 가 섞여 들어온 과거 데이터 방어
  const counts = normalizePopularityCounts({ 52605: 10, "65653": 5 });
  assert.equal(counts["52605"], 10);
  assert.equal(counts["65653"], 5);
});

ok("음수·0·NaN·null 은 버린다", () => {
  const counts = normalizePopularityCounts({ a: -1, b: 0, c: "nope", d: null, e: 3 });
  assert.deepEqual(Object.keys(counts), ["e"]);
});

ok("공백 키는 버린다", () => {
  const counts = normalizePopularityCounts({ "   ": 5, " 7 ": 2 });
  assert.equal(counts["   "], undefined);
  assert.equal(counts["7"], 2);
});

ok("비객체 입력에도 죽지 않는다", () => {
  for (const bad of [null, undefined, 1, "x", []]) {
    assert.deepEqual(normalizePopularityCounts(bad), {});
  }
});

// ── 실제 모달 배선 ──────────────────────────────────────────────────────────
const modal = readFileSync("src/components/onboarding/PlayerSelectModal.tsx", "utf8");

ok("모달이 정렬 함수를 사용", () => {
  assert.match(modal, /sortPlayersByPopularity/);
});

ok("팀 탭이 정렬을 통과", () => {
  // myTeamPlayers 는 팀 탭의 목록이자 전체 탭 미사용 시 기본 목록
  assert.match(
    modal,
    /myTeamPlayers\s*=\s*useMemo\(\s*\(\)\s*=>\s*sortPlayersByPopularity\(/,
    "팀 탭 목록이 인기순 정렬을 거쳐야 한다",
  );
});

ok("검색 결과가 정렬을 통과", () => {
  assert.match(
    modal,
    /if \(search\) \{[\s\S]*?sortPlayersByPopularity\(\s*allPlayers\.filter\(p => matchHangul/,
    "검색 결과도 인기순이어야 한다",
  );
});

ok("전체 탭이 정렬을 통과(기존 가나다순 단독 정렬 제거)", () => {
  assert.match(
    modal,
    /showAll \? sortPlayersByPopularity\(allPlayers, popularity\)/,
    "전체 탭도 인기순이어야 한다",
  );
  assert.doesNotMatch(
    modal,
    /showAll \? \[\.\.\.allPlayers\]\.sort/,
    "구 가나다순 단독 정렬이 남아 있으면 전체 탭이 인기순이 아니다",
  );
});

ok("집계는 서버 route 에서 받는다(클라이언트 profiles 직접 집계 금지)", () => {
  assert.match(modal, /fetch\("\/api\/player-popularity"\)/);
  assert.doesNotMatch(
    modal,
    /from\("profiles"\)/,
    "클라이언트가 profiles 를 직접 읽으면 1000행 truncation·개인정보 노출 위험",
  );
});

ok("최초 목록은 bounded timeout 뒤 고정(늦은 응답 재정렬 금지)", () => {
  assert.match(modal, /setPopularityStatus\("loading"\)/);
  assert.match(modal, /window\.setTimeout\([\s\S]*?1200\)/);
  assert.match(modal, /if \(stale \|\| settled\) return;[\s\S]*?setPopularity\(/);
  assert.match(modal, /data-testid="player-popularity-loading"/);
});

ok("기존 동작 보존: 선택 insertion order", () => {
  assert.match(
    modal,
    /선택 순서 보존[\s\S]*?\[\.\.\.selected\]/,
    "Set insertion order 기반 선택 순서가 유지돼야 한다",
  );
});

ok("기존 동작 보존: 선택 시 검색어 초기화", () => {
  assert.match(modal, /if \(willAdd && search\) \{[\s\S]*?setSearch\(""\)/);
});

ok("기존 동작 보존: 무한스크롤", () => {
  assert.match(modal, /setVisibleCount\(v => \{/);
  assert.match(modal, /displayPlayers = allDisplayPlayers\.slice\(0, visibleCount\)/);
});

// ── 선수 목록 페이지(/players) 정렬 토글 ──────────────────────────────────
// 하린아빠 2026-08-15: 게시글수·직찍수 토글은 집계가 없어 둘 다 가나다순으로 폴백되고
// 있었다(눌러도 목록 불변). 제거하고 인기순을 기본값으로 둔다.
const playersPageRaw = readFileSync("src/app/(main)/players/page.tsx", "utf8");

/**
 * 주석을 제거한 본문. "제거됐다" 계약은 코드에서 판정해야 한다 — 삭제 이유를
 * 설명하는 주석이 문자열을 인용했다는 이유로 FAIL 나면 게이트가 주석 검사기가 된다.
 */
const playersPage = playersPageRaw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

ok("/players 정렬 축은 인기순·가나다순 둘뿐", () => {
  assert.match(playersPage, /const SORT_MODES = \["popularity", "name"\] as const/);
  assert.match(playersPage, /popularity: "인기순"/);
  assert.match(playersPage, /name: "가나다순"/);
});

ok("/players 기본 정렬은 인기순", () => {
  assert.match(playersPage, /const DEFAULT_SORT: SortMode = "popularity"/);
});

ok("/players 에서 미구현 토글(게시글수·직찍수)이 제거됨", () => {
  // 라벨도 사용자에게 노출되면 안 되고, 같은 결과를 돌려주던 폴백도 남으면 안 된다.
  assert.doesNotMatch(playersPage, /"게시글수"/);
  assert.doesNotMatch(playersPage, /"직찍수"/);
  assert.doesNotMatch(playersPage, /TODO\(Phase 2\)/);
  assert.doesNotMatch(playersPage, /case "posts"|case "photos"/);
});

ok("/players 인기순이 공용 정렬 함수를 통과(별도 구현 금지)", () => {
  assert.match(playersPage, /sortPlayersByPopularity/);
  assert.match(playersPage, /from "@\/lib\/utils\/player-popularity"/);
  assert.match(
    playersPage,
    /if \(mode === "popularity"\) \{[\s\S]*?return sortPlayersByPopularity\(/,
    "인기순은 공용 함수로 가야 동률 가나다순 계약이 같이 간다",
  );
});

ok("/players 집계를 서버 route 에서 받는다(profiles 직접 조회 금지)", () => {
  assert.match(playersPage, /fetch\("\/api\/player-popularity"\)/);
  assert.match(playersPage, /normalizePopularityCounts\(/);
  assert.doesNotMatch(playersPage, /from\("profiles"\)/);
});

ok("/players 집계 실패에도 목록이 살아있다(fail-safe)", () => {
  // counts 를 빈 상태로 두면 전원 0 → 가나다순. 목록을 비우거나 throw 하면 안 된다.
  assert.match(playersPage, /useState<PopularityCounts>\(\{\}\)/);
  assert.match(playersPage, /\.catch\(\(\) =>/);
});

ok("/players 구 딥링크(?sort=posts·photos)가 기본값으로 정규화된다", () => {
  assert.match(
    playersPage,
    /function parseSortMode\(raw: string \| null\): SortMode \{[\s\S]*?DEFAULT_SORT/,
    "제거된 sort 값이 들어와도 빈 상태가 되면 안 된다",
  );
  assert.match(playersPage, /parseSortMode\(searchParams\.get\("sort"\)\)/);
});

ok("/players 기존 동작 보존: 검색·필터·무한스크롤", () => {
  assert.match(playersPage, /matchHangul\(p\.name, q\)/);
  assert.match(playersPage, /filterMode === "team" && filterTeam/);
  assert.match(playersPage, /setVisibleCount\(v => v \+ 20\)/);
});

// ── 서버 route 계약 ─────────────────────────────────────────────────────────
const route = readFileSync("src/app/api/player-popularity/route.ts", "utf8");

ok("route 가 DB RPC 로 집계(앱단 전체 스캔 금지)", () => {
  assert.match(route, /\.rpc\("favorite_player_counts", \{/);
  assert.match(route, /p_active_player_ids: ACTIVE_PLAYER_IDS/);
  assert.match(route, /players-roster\.json/);
  assert.doesNotMatch(route, /\.from\("profiles"\)\s*\.select/);
});

ok("route 실패 시 빈 맵 + degraded 로 폴백(온보딩 중단 금지)", () => {
  assert.match(route, /counts: \{\}, degraded: true/);
  assert.doesNotMatch(route, /status: 500/);
});

ok("route 응답에 개인 식별 정보 필드가 없다", () => {
  for (const leak of ["nickname", "user_id", "email", "profiles"]) {
    assert.doesNotMatch(
      route,
      new RegExp(`["']${leak}["']`),
      `응답 구성에 ${leak} 가 들어가면 안 된다`,
    );
  }
});

// ── migration 계약 ──────────────────────────────────────────────────────────
const sql = readFileSync(
  "supabase/migrations/20260803020000_favorite_player_counts_rpc.sql",
  "utf8",
);

ok("RPC 가 playerId 를 text 로 정규화", () => {
  assert.match(sql, /element ->> 'playerId'/);
});

ok("RPC 가 계정 단위로 중복 제거(count distinct)", () => {
  assert.match(sql, /count\(distinct p\.id\)/);
});

ok("RPC 가 active roster allowlist와 SQL 1,000행 hard bound를 강제", () => {
  assert.match(sql, /unnest\(p_active_player_ids\)/);
  assert.match(sql, /cardinality\(p_active_player_ids\) between 1 and 1000/);
  assert.match(sql, /join active_players as active/);
  assert.match(sql, /limit 1000/);
});

ok("RPC 반환에 개인 식별 컬럼이 없다", () => {
  assert.match(sql, /returns table \(player_id text, fan_count bigint\)/);
});

ok("RPC 직접 실행은 service_role만 허용", () => {
  assert.match(sql, /revoke all on function public\.favorite_player_counts\(text\[\]\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.favorite_player_counts\(text\[\]\) to service_role;/);
  assert.doesNotMatch(sql, /grant execute[\s\S]*to anon/);
});

console.log(`\n✅ player popularity order: PASS ${pass}/${pass}`);
