/**
 * KBO 경기 상태 판정 순수 헬퍼 (supabase/네트워크 의존 없음 — 스모크 테스트가 직접 import).
 */

/**
 * KBO CANCEL_SC_ID 판정 SSOT.
 * "0" = 정상 경기, 양의 정수 코드("1","3" 등) = 취소 사유(우천 등).
 * 빈 문자열/공백/undefined/null/비정상값은 '취소 아님'으로 안전 처리한다.
 *
 * KBO GetKboGameList가 예정 경기에 CANCEL_SC_ID를 빈 값으로 내려줄 때
 * `CANCEL_SC_ID !== "0"`가 true가 되어 정상 경기가 홈 경기카드에서 "경기 취소"로
 * 오표기되고 잘못된 '경기 취소' 푸시가 발송되던 버그 방지 (2026-07-23).
 */
export function isKboGameCancelled(cancelCode: string | number | null | undefined): boolean {
  const c = String(cancelCode ?? "").trim();
  return /^\d+$/.test(c) && Number(c) > 0;
}
