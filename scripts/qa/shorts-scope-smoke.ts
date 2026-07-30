// 숏츠 scope 칩(최애선수 | 마이팀 | 전체) 쿼리 분리 회귀 가드.
// 2026-07-30 CS 제안(풀카운트식 선택) — 삼순 조건부 GO 계약:
//   ① 화면 필터 금지 — scope별 서버측 쿼리 분리 (plan kind로 고정)
//   ② scope 미지정(구버전 앱) = 기존 혼합 피드와 완전 동일 (하위호환)
//   ③ scope 조건 미충족 시 빈 피드 — 다른 scope로 임의 폴백 금지
//   ④ LG 제목 역조회 합류(#769/#826)는 LG "팀 피드"가 포함될 때만
import {
  includesLgTeamFeed,
  parseShortsScope,
  resolveShortsQueryPlan,
} from "@/lib/video/shorts-feed-scope";
import { joinLgFeedRows, type ShortsRow } from "@/lib/video/shorts-feed-merge";

let pass = 0,
  fail = 0;
function check(label: string, actual: string | boolean, expected: string | boolean) {
  if (actual === expected) {
    console.log(`✓ ${label} → ${actual}`);
    pass++;
  } else {
    console.log(`✗ ${label} → expected ${expected}, got ${actual}`);
    fail++;
  }
}

// --- parseShortsScope: 유효값만 통과, 그 외 null(=하위호환 혼합) ---
check("parse favorite_players", parseShortsScope("favorite_players") === "favorite_players", true);
check("parse my_team", parseShortsScope("my_team") === "my_team", true);
check("parse all", parseShortsScope("all") === "all", true);
check("parse null → null", parseShortsScope(null) === null, true);
check("parse 오타/임의값 → null", parseShortsScope("favorite_player") === null, true);
check("parse 빈문자열 → null", parseShortsScope("") === null, true);

// --- ② 하위호환: scope 미지정 = 기존 분기 그대로 ---
check("legacy 팀+최애 → mixed(팀+선수 병합)", resolveShortsQueryPlan(null, "LG", 3).kind, "mixed");
check("legacy 팀만 → team_only", resolveShortsQueryPlan(null, "LG", 0).kind, "team_only");
check("legacy _ALL+최애 → all (기존 else 분기)", resolveShortsQueryPlan(null, "_ALL", 3).kind, "all");
check("legacy _ALL → all", resolveShortsQueryPlan(null, "_ALL", 0).kind, "all");

// --- ① scope별 단일 쿼리 경로 분리 ---
check("scope=favorite_players → player_only (팀 무관)", resolveShortsQueryPlan("favorite_players", "LG", 3).kind, "player_only");
check("scope=favorite_players team=_ALL → player_only", resolveShortsQueryPlan("favorite_players", "_ALL", 3).kind, "player_only");
check("scope=my_team → team_only (최애 있어도 병합 안 함)", resolveShortsQueryPlan("my_team", "LG", 3).kind, "team_only");
check("scope=all → all (team 파라미터 무시)", resolveShortsQueryPlan("all", "LG", 3).kind, "all");

// --- ③ 조건 미충족 → 빈 피드 (다른 scope 임의 폴백 금지) ---
check("scope=favorite_players 최애 미지정 → empty", resolveShortsQueryPlan("favorite_players", "LG", 0).kind, "empty");
check("scope=my_team 마이팀 미지정 → empty (all 폴백 금지)", resolveShortsQueryPlan("my_team", "_ALL", 3).kind, "empty");

// --- ④ LG 제목 역조회 합류 게이트: LG 팀 피드 포함 시에만 ---
check("legacy LG 혼합 → LG 합류 ON", includesLgTeamFeed(resolveShortsQueryPlan(null, "LG", 3), "LG"), true);
check("legacy LG 팀만 → LG 합류 ON", includesLgTeamFeed(resolveShortsQueryPlan(null, "LG", 0), "LG"), true);
check("scope=my_team LG → LG 합류 ON", includesLgTeamFeed(resolveShortsQueryPlan("my_team", "LG", 0), "LG"), true);
check("scope=favorite_players → LG 합류 OFF", includesLgTeamFeed(resolveShortsQueryPlan("favorite_players", "LG", 3), "LG"), false);
check("scope=all team=LG → LG 합류 OFF (행별 자기 팀 라벨)", includesLgTeamFeed(resolveShortsQueryPlan("all", "LG", 3), "LG"), false);
check("타 팀 → LG 합류 OFF", includesLgTeamFeed(resolveShortsQueryPlan("my_team", "KIA", 0), "KIA"), false);

// --- 피드 내 중복 제거 유지 (LG 합류 dedupe — #826 계약) ---
const row = (id: string, teamId: string, title: string): ShortsRow => ({
  video_id: id,
  title,
  team_id: teamId,
  channel_id: "ch1",
  published_at: "2026-07-29T00:00:00Z",
});
const joined = joinLgFeedRows(
  [row("v1", "LG", "LG 트윈스 하이라이트")],
  [row("v1", "키움", "LG 상대 하이라이트"), row("v2", "키움", "LG전 승리 하이라이트")],
  new Set(["ch1"]),
);
check("LG 합류: 동일 video_id 중복 0", joined.rows.filter((r) => r.video_id === "v1").length === 1, true);
check("LG 합류: 신규 행은 합류", joined.rows.some((r) => r.video_id === "v2"), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
