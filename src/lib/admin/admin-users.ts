/**
 * 관리자 이메일 화이트리스트 (2026-07-21 #cs 하린아빠 지정).
 *
 * 용도: "관리자만 볼 수 있는 UI"의 단일 SSOT.
 *  - 조회수 배지처럼 운영자에게만 노출하는 지표
 *  - 직관 스토리 등 WIP 기능을 prod 배포하되 관리자에게만 노출 → 실환경 QA 후 게이트 제거로 전체 롤아웃
 *
 * 클라이언트 게이트(표시 여부) 전용. 파괴적/권한 상승 작업의 서버 인가는 여기에 의존하지 말 것
 * (그건 admin_sessions PIN 세션 / profiles.is_operator RLS로 별도 처리).
 * 이 리스트는 클라 번들에 포함되며 시크릿이 아니다(표시 게이트일 뿐).
 */
export const ADMIN_EMAILS: readonly string[] = [
  "harinclaw@gmail.com",
  "yoonyeonryul@gmail.com",
];

/** 이메일이 관리자 화이트리스트에 속하는지. 대소문자/공백 무시. */
export function isAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

/**
 * 직관 라이브 WIP 실환경 QA용 GPS 우회 여부.
 * 서버에서는 반드시 검증된 유저 이메일로만 호출한다. 일반 관리자 인가를 대체하지 않는다.
 */
export function canBypassVenueGeofenceForQa(email?: string | null): boolean {
  return isAdminEmail(email);
}
