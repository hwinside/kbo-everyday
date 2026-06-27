/**
 * 리더보드 내부자 제외 SSOT
 *
 * 소스: 2026-04-20 #marketing 스레드 `1776644364.098599`
 *       하린아빠 수동 확정 (스크린샷 기반 7명)
 *
 * 정책:
 * - 리더보드/명예의 전당(누적·월별) 순위 집계에서 아래 user_id 제외
 * - 초대 리더보드 + 글쓰기 리더보드 모두에 공통 적용
 * - 리더보드 쿼리 레벨에서 필터
 *
 * 2026-06-09 하린아빠 확정: 운영자/테스트 계정 제외 일부 해제 → 명예의 전당에 함께 노출.
 * 잔류(제외 유지): 봇(움짤콜렉터) + 크보팬 운영팀 + QA테스터 — 순수 운영/봇/테스트 계정.
 * 해제(랭킹 노출): 하린아빠 / 정배현우 / 하린엄마 / 윤연률 / 김현우.
 * (프로즌 event_leaderboard_snapshot 은 이벤트 최종결과라 불변 — 본 변경은 라이브 뷰만 영향)
 *
 * 변경 절차:
 * - 봇/운영/테스트 계정 신규 발생 시 이 배열에 UUID 추가 + 주석 업데이트
 * - SQL 함수 leaderboard_internal_user_ids() 와 1:1 동기화 (새 migration 필수)
 * - 커밋 메시지 prefix: `chore(events): leaderboard exclusion add/remove ...`
 */

export const LEADERBOARD_INTERNAL_USER_IDS: readonly string[] = [
  '75ee70e1-d5d1-4cbe-a2f7-a937e717437c', // 움짤콜렉터 (봇, is_bot) · 2026-06-01 제외 확정
  '7b58d68e-e212-40aa-a96d-5018cb82cc81', // 크보팬 운영팀 (ops@keubo.fan) · 2026-06-09 제외 유지
  'ee5c25d8-bcab-4bb1-aa11-f64041d5e322', // QA테스터 (qa@keubo.fan) · 2026-06-09 제외 유지
] as const

/** Set lookup 헬퍼 (O(1) 체크용) */
export const LEADERBOARD_INTERNAL_USER_ID_SET = new Set<string>(
  LEADERBOARD_INTERNAL_USER_IDS,
)

/** 주어진 user_id가 내부자(리더보드 제외 대상)인지 확인 */
export function isInternalUser(userId: string | null | undefined): boolean {
  if (!userId) return false
  return LEADERBOARD_INTERNAL_USER_ID_SET.has(userId)
}
