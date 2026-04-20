/**
 * 리더보드 내부자 제외 SSOT
 *
 * 소스: 2026-04-20 #marketing 스레드 `1776644364.098599`
 *       하린아빠 수동 확정 (스크린샷 기반 7명)
 *
 * 정책:
 * - 이벤트 기간(4/20~5/31) 전체 누적 리더보드에서 아래 user_id 제외
 * - 초대 리더보드 + 글쓰기 리더보드 모두에 공통 적용
 * - 리더보드 쿼리 레벨에서 필터 (운영자 계정은 참여는 하되 순위 집계에서만 제외)
 *
 * 변경 절차:
 * - 운영자/테스트 계정 신규 발생 시 이 배열에 UUID 추가 + 주석 업데이트
 * - 커밋 메시지 prefix: `chore(events): leaderboard exclusion add/remove ...`
 */

export const LEADERBOARD_INTERNAL_USER_IDS: readonly string[] = [
  '04f1fcff-6173-4dda-920a-e5f8ff66a696', // seq 1 · 하린아빠 (harinclaw@gmail.com)
  '3e38a6c9-c43a-418f-8809-75db09ac247c', // seq 4 · 정배현우 (hwinside@gmail.com)
  '7b58d68e-e212-40aa-a96d-5018cb82cc81', // seq 5 · 크보팬 운영팀 (ops@keubo.fan)
  '256c43ce-9a44-4c3e-9eb6-6bf64378bb4a', // seq 6 · 하린엄마 (lovism486@hotmail.com)
  'ee5c25d8-bcab-4bb1-aa11-f64041d5e322', // seq 7 · QA테스터 (qa@keubo.fan)
  '9cba194d-686d-4d17-b5ac-185b34bc2dc6', // seq 8 · 윤연률 (yoonyeonryul@gmail.com)
  'a8b26be1-ea79-45d1-a6a4-9c5a13c91768', // seq 62 · 김현우 (nbpnaver.backup@gmail.com)
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
