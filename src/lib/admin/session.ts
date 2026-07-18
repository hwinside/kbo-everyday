import { createHash, randomBytes } from "crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";

/**
 * 어드민 세션 (2026-07-18, PR #681 삼순 P0 반영).
 *
 * PIN 원문을 클라이언트 storage에 저장하는 대신, PIN 검증 성공 시 서버가
 * 기기별 랜덤 세션 토큰을 발급해 HttpOnly; Secure; SameSite=Strict 쿠키로만 내려준다.
 * - JS-readable storage에 credential 없음 (XSS/공급망 사고 시에도 PIN 비노출)
 * - DB에는 토큰 sha256 해시만 저장 (DB 유출 시에도 토큰 원문 미노출)
 * - 기기(행) 단위 폐기 가능: admin_sessions 행 delete/revoked_at 마킹 = 해당 기기 즉시 로그아웃
 */

export const ADMIN_SESSION_COOKIE = "admin_session";
/** 180일 — 만료 시 PIN 재입력 (홈 화면 앱 기준 사실상 반영구) */
export const ADMIN_SESSION_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** PIN 검증 성공 후 호출 — 새 기기 세션 생성, 쿠키에 넣을 토큰 원문 반환 */
export async function createAdminSession(userAgent: string | null): Promise<string | null> {
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  const { error } = await supabase.from("admin_sessions").insert({
    token_hash: hashToken(token),
    user_agent: (userAgent || "").slice(0, 300) || null,
    created_at: now.toISOString(),
    last_used_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ADMIN_SESSION_MAX_AGE_SECONDS * 1000).toISOString(),
  });
  if (error) return null;
  return token;
}

/** 쿠키 토큰 검증 — 미폐기 + 미만료 행 존재 시에만 true. last_used_at은 1시간 스로틀로 갱신 */
export async function verifyAdminSessionToken(token: string): Promise<boolean> {
  if (!token || token.length < 32) return false;
  const tokenHash = hashToken(token);
  const { data, error } = await supabase
    .from("admin_sessions")
    .select("id,last_used_at,expires_at,revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error || !data) return false;
  if (data.revoked_at) return false;
  if (!data.expires_at || new Date(data.expires_at).getTime() <= Date.now()) return false;

  const lastUsed = data.last_used_at ? new Date(data.last_used_at).getTime() : 0;
  if (Date.now() - lastUsed > 60 * 60 * 1000) {
    // best-effort — 실패해도 인증 결과엔 영향 없음
    await supabase
      .from("admin_sessions")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", data.id);
  }
  return true;
}

/** Request 헤더에서 세션 쿠키 추출 (NextRequest 외 plain Request도 지원) */
export function getAdminSessionTokenFromRequest(request: Request): string {
  const cookieHeader = request.headers.get("cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === ADMIN_SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return "";
}
