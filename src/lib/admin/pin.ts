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

export function isAdminRequest(request: Request): boolean {
  return verifyAdminPinValue(getAdminPinFromRequest(request));
}
