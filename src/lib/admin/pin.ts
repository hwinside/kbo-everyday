import { scryptSync, timingSafeEqual } from "crypto";

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
export async function isAdminAuthedRequest(request: Request): Promise<boolean> {
  if (verifyAdminPinValue(getAdminPinFromRequest(request))) return true;
  const { verifyAdminSessionToken, getAdminSessionTokenFromRequest } = await import("./session");
  const token = getAdminSessionTokenFromRequest(request);
  if (!token) return false;
  return verifyAdminSessionToken(token);
}
