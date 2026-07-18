/**
 * 쪽지 알림 트리거 입력 검증 (순수 함수, 2026-07-18 PR #681 2차 리뷰 P0 반영).
 *
 * dm_messages.id는 BIGSERIAL(정수)이고 클라 모델도 DMMessage.id: number다.
 * 라우트가 문자열로 검증하면 항상 400 → 알림이 아예 안 온다. 여기서 number 또는
 * 정수 문자열을 안전하게 정규화해 route/claim(bigint) 양쪽에서 재사용한다.
 * (bigint라 Number 정밀도 손실 방지: 문자열 정수도 그대로 받아 숫자 리터럴만 확인)
 */
export function normalizeMessageId(input: unknown): number | null {
  if (typeof input === "number") {
    if (Number.isInteger(input) && input > 0 && Number.isSafeInteger(input)) return input;
    return null;
  }
  if (typeof input === "string") {
    if (!/^[1-9]\d{0,15}$/.test(input)) return null; // 양의 정수 문자열, 16자리 이내(safe)
    const n = Number(input);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}
