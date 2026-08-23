/**
 * 군 복무 구단 표기 라벨 (공용 SSOT).
 *
 * 상무 정책 (2026-08-23 하린아빠 지시 + 삼순 확정):
 * - roster `team`/`teamId`는 원소속 KBO 구단 유지 (검색·팀필터·관심선수 모두 원소속 기준)
 * - 프로필에는 별도 상태로 군 복무를 명시한다
 * - hero/fallback 두 프로필 분기가 이 함수 하나를 공유해 표기 누락을 구조적으로 막는다
 *   (삼순 #1292 NO-GO P0: 배지가 hero 분기에만 있어 hero allowlist 밖 33명 표기 0 재발 방지)
 */
export function militaryLabel(military: string | null | undefined): string | null {
  if (!military || typeof military !== "string" || !military.trim()) return null;
  return `${military.trim()} 복무 중`;
}
