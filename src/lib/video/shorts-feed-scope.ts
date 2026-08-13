/**
 * 숏츠 피드 scope 쿼리 플랜 (2026-07-30 CS 제안 — 풀카운트식 최애/마이팀/전체 선택).
 *
 * scope 파라미터가 없으면(구버전 앱) 기존 혼합 피드와 완전히 동일하게 동작해야
 * 하는 하위호환 계약이 있어, 라우트의 쿼리 분기를 순수 함수로 분리해 스모크로
 * 고정한다 (scripts/qa/shorts-scope-smoke.ts).
 */

export type ShortsScope = "favorite_players" | "my_team" | "all";

export function parseShortsScope(raw: string | null): ShortsScope | null {
  return raw === "favorite_players" || raw === "my_team" || raw === "all"
    ? raw
    : null;
}

export type ShortsQueryPlan =
  /** 요청 scope를 충족할 조건이 없음(최애선수/마이팀 미지정) → 빈 피드. 다른 scope로 임의 폴백 금지 */
  | { kind: "empty" }
  /** 최애선수 전용: player_ids overlaps 단일 쿼리 (팀 무관) */
  | { kind: "player_only" }
  /** 마이팀 전용: team_id 단일 쿼리 */
  | { kind: "team_only" }
  /** 팀 필터 없는 최신순 단일 쿼리 (fetchLimit bounded) — 하위호환(scope 미지정 + 마이팀 미지정) 전용 */
  | { kind: "all" }
  /** 하위호환 기본값: 팀 쿼리 + 최애선수 쿼리 병합 (기존 동작 그대로) */
  | { kind: "mixed" };

export function resolveShortsQueryPlan(
  scope: ShortsScope | null,
  team: string,
  playerIdCount: number,
): ShortsQueryPlan {
  if (scope === "favorite_players") {
    return playerIdCount > 0 ? { kind: "player_only" } : { kind: "empty" };
  }
  if (scope === "all") {
    // 2026-08-13 하린아빠 결정: 전체 = 마이팀 + 최애선수 병합.
    // #973 도입 당시 scope=all은 팀 필터 없는 전체 쿼리였는데, 수집 풀의
    // 뉴스 채널(team_id=ETC) 숏츠가 최신순을 도배해 야구 무관 피드가 됨(#cs 제보).
    // 마이팀+최애선수 병합으로 재정의 — ETC 행은 최애선수 태깅이 없는 한 미포함.
    if (team !== "_ALL" && playerIdCount > 0) return { kind: "mixed" };
    if (team !== "_ALL") return { kind: "team_only" };
    if (playerIdCount > 0) return { kind: "player_only" };
    return { kind: "empty" };
  }
  if (scope === "my_team") {
    // 마이팀 미지정(_ALL)인데 my_team scope 요청 → 빈 피드.
    // 다른 scope로 임의 폴백하지 않는다(명시적 scope 계약). UI는 마이팀 미지정
    // 상태에서 섹션 자체를 렌더하지 않아 정상 경로에선 도달하지 않는다.
    return team !== "_ALL" ? { kind: "team_only" } : { kind: "empty" };
  }
  // scope 미지정: 구버전 앱 하위호환 — 기존 분기 그대로
  if (team !== "_ALL" && playerIdCount > 0) return { kind: "mixed" };
  if (team !== "_ALL") return { kind: "team_only" };
  return { kind: "all" };
}

/**
 * LG 제목 역조회 합류(#826 다중 팀 노출)는 "LG 팀 피드"가 결과에 포함될 때만
 * 필요하다. 최애선수 전용/하위호환 전체(kind "all")에서는 각 행이 자기 team_id로
 * 노출되므로 합류(라벨 override 포함)를 걸지 않는다. scope=all은 마이팀 병합
 * (mixed/team_only)으로 해석되므로 LG 마이팀이면 자동으로 합류가 걸린다.
 */
export function includesLgTeamFeed(plan: ShortsQueryPlan, team: string): boolean {
  return team === "LG" && (plan.kind === "mixed" || plan.kind === "team_only");
}
