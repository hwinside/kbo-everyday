/**
 * 리더보드 내부자 제외 SSOT (정적 부분)
 *
 * 소스: 2026-04-20 #marketing 스레드 `1776644364.098599`
 *       하린아빠 수동 확정 (스크린샷 기반 7명)
 *
 * 정책:
 * - 리더보드/명예의 전당(누적·월별) 순위 집계에서 내부자 제외
 * - 초대 리더보드 + 글쓰기 리더보드 모두에 공통 적용
 * - 실제 필터는 SQL 뷰(v_leaderboard_writing / _monthly / v_leaderboard_invite)가
 *   leaderboard_internal_user_ids() 로 수행 (이 TS는 앱 코드에서 직접 소비되지 않는 문서/미러)
 *
 * 2026-06-09 하린아빠 확정: 운영자/테스트 계정 제외 일부 해제 → 명예의 전당에 함께 노출.
 * 해제(랭킹 노출): 하린아빠 / 정배현우 / 하린엄마 / 윤연률 / 김현우.
 *
 * 2026-07-15 (PR #645, 삼순 리뷰): 봇 계정은 하드코딩이 아니라 profiles.is_bot=true 로
 *   SQL 함수에서 *동적* 제외한다. 움짤콜렉터·짤콜렉터·향후 봇 전부 자동 커버.
 *   → 아래 배열은 봇이 아닌 순수 운영/테스트 계정(is_bot=false)만 유지한다.
 *   (움짤콜렉터 75ee70e1 은 is_bot=true 라 동적 절이 커버 → 하드코딩에서 제거, 무회귀)
 *
 * 변경 절차:
 * - 신규 *봇* 계정: is_bot=true 로 seed하면 자동 제외 — TS/SQL 편집 불필요.
 * - 신규 *운영/테스트* 계정(is_bot=false): 이 배열에 UUID 추가 + SQL 함수 하드코딩 절
 *   (leaderboard_internal_user_ids())과 1:1 동기화 (새 migration 필수).
 * - 커밋 메시지 prefix: `chore(events): leaderboard exclusion add/remove ...`
 */

export const LEADERBOARD_INTERNAL_USER_IDS: readonly string[] = [
  '7b58d68e-e212-40aa-a96d-5018cb82cc81', // 크보팬 운영팀 (ops@keubo.fan) · 2026-06-09 제외 유지
  'ee5c25d8-bcab-4bb1-aa11-f64041d5e322', // QA테스터 (qa@keubo.fan) · 2026-06-09 제외 유지
] as const

/** Set lookup 헬퍼 (O(1) 체크용) */
export const LEADERBOARD_INTERNAL_USER_ID_SET = new Set<string>(
  LEADERBOARD_INTERNAL_USER_IDS,
)

/**
 * 주어진 user_id가 *정적* 내부자(운영/테스트 계정)인지 확인.
 * 봇(is_bot=true)은 이 목록에 없고 SQL 뷰에서 동적 제외되므로 여기선 판정하지 않는다.
 */
export function isInternalUser(userId: string | null | undefined): boolean {
  if (!userId) return false
  return LEADERBOARD_INTERNAL_USER_ID_SET.has(userId)
}
