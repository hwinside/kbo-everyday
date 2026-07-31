/**
 * 숏츠 scope 칩 UI 상태 계약 (2026-07-30 삼순 재리뷰 게이트 반영).
 *
 * ① 신규 UI는 항상 세 scope(최애선수|마이팀|전체) 중 정확히 1개 활성.
 *    무선택/혼합(null) 상태 없음, active 재탭 = no-op. legacy 혼합 피드는
 *    scope 미지정 구버전 API 하위호환 전용으로만 남는다(신규 UI 도달 불가).
 * ② scope 전환 race: 늦게 끝난 이전 scope 응답이 현재 scope 결과를
 *    덮어쓰면 안 된다 — LatestOnlyGate로 latest-only commit 보장.
 * 회귀: scripts/qa/shorts-scope-smoke.ts
 */

import type { ShortsScope } from "@/lib/video/shorts-feed-scope";

/**
 * 초기 활성 scope 결정. 섹션은 마이팀 지정 시에만 렌더되므로(team 필수)
 * 기본값은 최애선수 있음 → 최애선수, 없으면 마이팀 (삼순 제안 기본값).
 * 저장값이 현재 상태에서 불가능하면(최애선수 미지정) 기본값으로 폴백.
 */
export function resolveInitialShortsScope(
  saved: ShortsScope | null,
  favPlayerCount: number,
): ShortsScope {
  if (saved && (saved !== "favorite_players" || favPlayerCount > 0)) return saved;
  return favPlayerCount > 0 ? "favorite_players" : "my_team";
}

/** 칩 탭 전이: active 재탭 = no-op(그대로), 다른 칩 = 전환. null 반환 없음. */
export function nextShortsScopeOnTap(
  current: ShortsScope,
  tapped: ShortsScope,
): ShortsScope {
  return current === tapped ? current : tapped;
}

/**
 * latest-only commit 게이트. begin()으로 요청 토큰을 발급하고, 응답 도착 시
 * isCurrent(token)이 true일 때만 상태를 commit한다. 늦게 도착한 이전 scope
 * 응답(성공이든 실패든)은 최신 요청 토큰이 아니므로 버려진다.
 */
export class LatestOnlyGate {
  private current = 0;

  begin(): number {
    this.current += 1;
    return this.current;
  }

  isCurrent(token: number): boolean {
    return token === this.current;
  }
}
