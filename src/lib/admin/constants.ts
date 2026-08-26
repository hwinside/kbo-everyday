/**
 * 어드민 세션 센티넬 (SSOT).
 *
 * AdminShell이 세션 쿠키 인증 성공 후 sessionStorage["admin_pin"]에 이 값을 심고,
 * admin 페이지들의 apiFetch가 그걸 x-admin-pin 헤더로 항상 전송한다. 이 값은 실제 PIN이
 * 아니라 "PIN이 아니라 세션 쿠키로 인증하라"는 표식이므로, 서버는 이 값에 대해
 * scrypt(16MB·이벤트루프 블로킹) 검증을 건너뛴다 (2026-08-26 삼순 P0).
 */
export const ADMIN_SESSION_SENTINEL = "session";
