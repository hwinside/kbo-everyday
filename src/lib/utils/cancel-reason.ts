/**
 * 취소 사유 표시 SSOT.
 *
 * 왜 별도 모듈인가: 취소 사유는 KBO `CANCEL_SC_NM` 원문(`우천취소`/`폭염취소`/`그라운드사정`)이고
 * **열린 집합**이다. 새 사유가 생길 때마다 매핑 룰을 늘리면 반례마다 룰이 쌓인다
 * (AGENTS lessons `open_language_never_closes_with_rules`). 그래서 이 모듈은 사유를
 * **변환하지 않고 그대로 노출**하고, 코드가 고정하는 건 "감싸는 문구"뿐이다.
 *
 * provenance 계약: `null`/`undefined` 는 "사유 없는 취소"가 아니라 **"사유를 못 받았다"** 이다.
 * (Naver 폴백 경로에는 이 필드가 원리적으로 없다.) 그러므로 부재 시에는 사유를 지어내지 않고
 * 기존 고정 문구로 fallback 한다.
 */

/** 표시 가능한 사유 문자열의 상한 — upstream 열화로 장문/쓰레기 값이 와도 UI를 깨지 않는다. */
const MAX_REASON_LENGTH = 20;

/**
 * 표시용 사유 정규화. 유효하지 않으면 null(= 표시하지 않음, 고정 문구 fallback).
 *
 * - 공백만/빈 값 → null
 * - 제어문자 포함 또는 상한 초과 → null (열화 신호를 사용자에게 그대로 흘리지 않는다)
 * - 그 외 → trim 한 원문 그대로 (변환·매핑 없음)
 */
export function normalizeCancelReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_REASON_LENGTH) return null;
  // 제어문자 자체가 검사 대상이다(upstream 열화 신호).
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * 배지·카드용 짧은 라벨. 사유가 있으면 원문 그대로(예: `우천취소`), 없으면 `취소`.
 *
 * 원문을 그대로 쓰는 이유: KBO 사유는 이미 `~취소`/`그라운드사정` 처럼 완결된 명사구다.
 * `${사유} 취소` 로 조립하면 `우천취소 취소` 같은 중복이 나고, 그걸 막으려면 다시 룰이 쌓인다.
 */
export function cancelReasonBadge(reason: string | null | undefined): string {
  return normalizeCancelReason(reason) ?? "취소";
}

/**
 * 상세 배너 보조문구. 사유를 받았을 때만 `사유: X` 를 돌려주고, 못 받았으면 null.
 * 호출부는 null 일 때 기존 고정 문구를 그대로 렌더한다(사유 미상이라고 단정하지 않는다).
 */
export function cancelReasonDetail(reason: string | null | undefined): string | null {
  const normalized = normalizeCancelReason(reason);
  return normalized ? `사유: ${normalized}` : null;
}
