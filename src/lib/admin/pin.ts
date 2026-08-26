import { scryptSync, timingSafeEqual } from "crypto";
import { ADMIN_SESSION_SENTINEL } from "./constants";

function parseScryptHash(value: string): { salt: string; hash: string } | null {
  const normalized = value.startsWith("scrypt$")
    ? value.replace(/^scrypt\$/, "scrypt:")
    : value;

  const parts = normalized.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return null;

  const [, salt, hash] = parts;
  if (!salt || !hash) return null;
  return { salt, hash };
}

export function hasAdminPinConfig(): boolean {
  return Boolean(process.env.ADMIN_PIN || process.env.ADMIN_PIN_HASH);
}

export function verifyAdminPinValue(pin: string | null | undefined): boolean {
  if (!pin) return false;

  const pinHash = process.env.ADMIN_PIN_HASH;
  if (pinHash) {
    const parsed = parseScryptHash(pinHash);
    if (!parsed) return false;

    const derived = scryptSync(pin, parsed.salt, Buffer.from(parsed.hash, "hex").length);
    const expected = Buffer.from(parsed.hash, "hex");

    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }

  const adminPin = process.env.ADMIN_PIN;
  if (!adminPin) return false;

  const actual = Buffer.from(pin);
  const expected = Buffer.from(adminPin);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function getAdminPinFromRequest(request: Request): string {
  const headerPin = request.headers.get("x-admin-pin");
  if (headerPin) return headerPin;

  const authHeader = request.headers.get("authorization") || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1]?.trim() || "";
}

/**
 * 어드민 요청 인증 (2026-07-18 세션 쿠키 도입으로 async 전환).
 * 1) x-admin-pin 헤더(서버-서버/스크립트용, 기존 경로 유지) → 2) admin_session HttpOnly 쿠키.
 * ⚠️ Promise를 반환하므로 호출부에서 반드시 await 필요 — 동기 isAdminRequest는 오용(미await=항상 truthy) 방지를 위해 제거했다.
 */
export type AdminAuthCheck = "ok" | "unauthorized" | "unavailable";

/**
 * 어드민 인증 3-state (2026-08-26 삼순 P0).
 * PIN 헤더(서버-서버/스크립트) → admin_session 쿠키 순. 세션 저장소 transient 에러는
 * "unavailable"로 반환해 호출부가 401(무효)과 503(일시 장애)을 구분할 수 있게 한다.
 */
export async function checkAdminAuth(request: Request): Promise<AdminAuthCheck> {
  const pin = getAdminPinFromRequest(request);
  // 센티넬은 실제 PIN이 아니라 "세션 쿠키로 인증하라"는 표식 → scryptSync(16MB·이벤트루프 블로킹) 건너뜀 (삼순 P0).
  if (pin && pin !== ADMIN_SESSION_SENTINEL && verifyAdminPinValue(pin)) return "ok";

  const { checkAdminSessionToken, getAdminSessionTokenFromRequest } = await import("./session");
  const token = getAdminSessionTokenFromRequest(request);
  if (!token) return "unauthorized";
  const result = await checkAdminSessionToken(token);
  if (result === "valid") return "ok";
  if (result === "error") return "unavailable";
  return "unauthorized";
}

export async function isAdminAuthedRequest(request: Request): Promise<boolean> {
  return (await checkAdminAuth(request)) === "ok";
}

/**
 * 어드민 GET 대시보드 라우트용 가드 (2026-08-26 삼순 P0).
 * authed면 null, 미인증이면 401, 세션 저장소 일시 장애면 503(≠401)을 반환한다.
 * 503은 프론트 재시도 트리거이자 유령 로그아웃 방지용 — transient 에러를 clean-401로
 * 뭉개지 않는다.
 */
export async function requireAdmin(request: Request): Promise<Response | null> {
  const result = await checkAdminAuth(request);
  if (result === "ok") return null;
  if (result === "unavailable") {
    return Response.json({ error: "Auth store temporarily unavailable" }, { status: 503 });
  }
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
