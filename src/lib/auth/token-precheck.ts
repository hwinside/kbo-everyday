import { createHash } from "node:crypto";
import type { User } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Local token precheck + dead-token negative cache (pure logic, no Supabase
// client import — unit-testable without env).
//
// Why: every `auth.getUser(token)` call hits Supabase `/auth/v1/user`. Stale
// clients (expired/killed sessions still polling) burned ~4.4k 403s in a
// single evening window (2026-08-11), lighting up the Supabase warnings
// dashboard. Two cheap layers keep dead tokens from ever reaching Supabase:
//
//  1. exp precheck — a JWT whose `exp` is already past can never validate;
//     reject locally without a network call.
//  2. negative cache — a token Supabase definitively rejected (4xx) belongs
//     to a destroyed session and cannot come back to life; remember its hash
//     and short-circuit repeats. Transient failures (5xx/network) are NOT
//     cached so an auth outage never locks users out.
// ---------------------------------------------------------------------------

const EXP_SLACK_MS = 30_000; // tolerate small clock skew before rejecting
const DEAD_TOKEN_TTL_MS = 15 * 60_000; // cache window per dead token
const DEAD_TOKEN_MAX_ENTRIES = 5_000; // hard cap (per warm serverless instance)

const deadTokens = new Map<string, number>(); // sha256(token) -> expiresAtMs

/** Decode a JWT payload without verifying the signature (verification is
 * Supabase's job — we only peek at `exp` for a cheap local reject). */
export function decodeJwtExpMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof payload?.exp !== "number" || !Number.isFinite(payload.exp)) return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/** True when the token is structurally a JWT and not yet expired. Tokens that
 * are not JWT-shaped are rejected outright (Supabase access tokens are JWTs). */
export function passesLocalPrecheck(token: string, nowMs = Date.now()): boolean {
  if (token.split(".").length !== 3) return false;
  const expMs = decodeJwtExpMs(token);
  if (expMs === null) return true; // let Supabase decide unusual-but-JWT-shaped tokens
  return expMs + EXP_SLACK_MS > nowMs;
}

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isKnownDeadToken(token: string, nowMs = Date.now()): boolean {
  const key = tokenKey(token);
  const until = deadTokens.get(key);
  if (until === undefined) return false;
  if (until <= nowMs) {
    deadTokens.delete(key);
    return false;
  }
  return true;
}

export function markTokenDead(token: string, nowMs = Date.now()): void {
  if (deadTokens.size >= DEAD_TOKEN_MAX_ENTRIES) {
    // Evict expired entries first; if still full, drop oldest-inserted.
    for (const [k, until] of deadTokens) {
      if (until <= nowMs) deadTokens.delete(k);
    }
    while (deadTokens.size >= DEAD_TOKEN_MAX_ENTRIES) {
      const oldest = deadTokens.keys().next().value;
      if (oldest === undefined) break;
      deadTokens.delete(oldest);
    }
  }
  deadTokens.set(tokenKey(token), nowMs + DEAD_TOKEN_TTL_MS);
}

/** Test hook: reset the negative cache between smoke scenarios. */
export function _clearDeadTokenCache(): void {
  deadTokens.clear();
}

type GetUserFn = (
  token: string,
) => Promise<{ data: { user: User | null }; error: { status?: number } | null }>;

/** Core verifier with an injectable Supabase call (unit-testable). */
export async function verifyAccessTokenWith(
  getUserFn: GetUserFn,
  token: string,
  nowMs = Date.now(),
): Promise<User | null> {
  if (!token) return null;
  if (!passesLocalPrecheck(token, nowMs)) return null;
  if (isKnownDeadToken(token, nowMs)) return null;

  const { data, error } = await getUserFn(token);
  if (error || !data.user) {
    // Only cache definitive auth rejections (4xx). Transient failures
    // (5xx / network errors without a status) must stay retryable.
    const status = error?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      markTokenDead(token, nowMs);
    }
    return null;
  }
  return data.user;
}
