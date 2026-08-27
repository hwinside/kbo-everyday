/**
 * 어드민 세션 검증 결과 분류 (순수 로직, DB/env 의존 없음) — 2026-08-26 삼순 P0.
 *
 * checkAdminSessionToken이 admin_sessions 조회 후 이 함수로 판정한다. supabaseAdmin을
 * import하지 않으므로 node가 env 없이 직접 import해 결함 주입 테스트할 수 있다
 * (qa:admin-auth-loading). 핵심: transient 조회 error를 "토큰 무효"와 분리한다.
 */
export type AdminSessionCheck = "valid" | "invalid" | "error";

export interface AdminSessionRow {
  expires_at: string | null;
  revoked_at: string | null;
}

export function classifyAdminSessionRow(
  row: AdminSessionRow | null | undefined,
  error: unknown,
  now: number = Date.now(),
): AdminSessionCheck {
  // transient 조회 에러가 최우선 — 행이 함께 와도 error를 무효로 감추지 않는다(유령 401 방지).
  if (error) return "error";
  if (!row) return "invalid";
  if (row.revoked_at) return "invalid";
  if (!row.expires_at || new Date(row.expires_at).getTime() <= now) return "invalid";
  return "valid";
}
