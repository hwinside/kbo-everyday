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

/**
 * 취소 사유 원문(KBO `CANCEL_SC_NM`) 정규화 SSOT.
 *
 * 값-플래그 결속: **status 가 `cancelled` 일 때만** 사유를 실는다. 이렇게 묶어야
 * 상태가 live/final 로 뒤집힌 경기에 사유만 남아 UI 가 취소로 오표기하는 경로가
 * 구조적으로 불가능해진다(2026-08-15 provenance 계약과 동일 축).
 *
 * provenance: 사유를 못 받았으면 빈 문자열이 아니라 **null**(= 미확인)을 돌려준다.
 * Naver 폴백 경로에는 이 필드가 원리적으로 없으므로 "사유 없는 취소"와 구분돼야 한다.
 *
 * 실측 사유(2026-08): `우천취소`(ID 1) · `그라운드사정`(6) · `폭염취소`(9).
 */
export function parseCancelReason(
  status: string,
  rawName: string | null | undefined,
): string | null {
  if (status !== "cancelled") return null;
  const name = String(rawName ?? "").trim();
  return name.length > 0 ? name : null;
}
