import { createHash, randomBytes } from "crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { classifyAdminSessionRow, type AdminSessionCheck } from "./session-policy";

export type { AdminSessionCheck } from "./session-policy";

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

/**
 * 인스턴스 메모리 TTL 캐시 (2026-08-26 삼순 P1).
 * 동시 다발 요청이 admin_sessions를 매번 때리지 않게 valid 토큰만 짧게 캐시한다.
 * ⚠️ 트레이드오프: revoke/expire가 최대 TTL(45초)만큼 지연 반영된다. invalid/error는 캐시하지 않아
 * (a) 잘못된 401이 굳지 않고 (b) transient 에러가 valid로 승격되지 않는다.
 */
const SESSION_CACHE_TTL_MS = 45 * 1000;
const sessionCache = new Map<string, number>(); // tokenHash -> expiresAt(ms)

/** 쿠키 토큰 검증 — 미폐기 + 미만료 행 존재 시 "valid". last_used_at은 1시간 스로틀로 갱신 */
export async function checkAdminSessionToken(token: string): Promise<AdminSessionCheck> {
  if (!token || token.length < 32) return "invalid";
  const tokenHash = hashToken(token);

  const cachedUntil = sessionCache.get(tokenHash);
  if (cachedUntil && cachedUntil > Date.now()) return "valid";
  if (cachedUntil) sessionCache.delete(tokenHash);

  const { data, error } = await supabase
    .from("admin_sessions")
    .select("id,last_used_at,expires_at,revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  const verdict = classifyAdminSessionRow(data, error);
  if (verdict === "error") {
    // transient PostgREST/커넥션 에러를 "토큰 무효"와 분리 — 조용한 401/유령 로그아웃 방지 + 진단 로그.
    console.error("[admin-session] token lookup failed", error?.message || error);
    return "error";
  }
  if (verdict !== "valid" || !data) return "invalid";

  const lastUsed = data.last_used_at ? new Date(data.last_used_at).getTime() : 0;
  if (Date.now() - lastUsed > 60 * 60 * 1000) {
    // best-effort — 실패해도 인증 결과엔 영향 없음
    await supabase
      .from("admin_sessions")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", data.id);
  }
  sessionCache.set(tokenHash, Date.now() + SESSION_CACHE_TTL_MS);
  return "valid";
}

/** back-compat boolean 래퍼 — 기존 호출부(auth/route 등) 유지. transient error는 무효와 동일하게 false. */
export async function verifyAdminSessionToken(token: string): Promise<boolean> {
  return (await checkAdminSessionToken(token)) === "valid";
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
