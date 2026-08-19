import { createHash } from "node:crypto";

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
//  2. negative cache — a token Supabase definitively rejected (a closed set
//     of Auth error codes: bad_jwt / session_expired / …) belongs to a
//     destroyed session and cannot come back to life; remember its hash and
//     short-circuit repeats. Anything else — 429 rate limit, 408 timeout,
//     5xx, network errors, or a 4xx without a definitive code — is NOT
//     cached, so an Auth outage or rate-limit burst never locks live users
//     out (fail-open to retry).
// ---------------------------------------------------------------------------

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
  // No forward slack: a token at/past exp can never validate — reject NOW.
  // (Slack here would let already-expired tokens hit /auth/v1/user for its
  // duration — 삼순 2차 리뷰 지적. Clock-behind skew merely delays the local
  // reject boundary; Supabase remains the authority for live tokens.)
  return expMs > nowMs;
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

/** Auth error codes that PROVE the token/session is dead and can never
 * validate again. Per Supabase docs, judge by `error.code`, not HTTP status —
 * status alone also matches 429 over_request_rate_limit / 408 request_timeout,
 * which must stay retryable. Closed set; expand only with evidence. */
const DEAD_TOKEN_ERROR_CODES = new Set([
  "bad_jwt",
  "session_expired",
  "session_not_found",
  "user_not_found",
  "user_banned",
]);

/** Injected verifier. Generic over the user shape so the caller can return a
 * narrow projection (see verified-user.ts `VerifiedUser`) instead of the full
 * supabase `User` — narrowing is what makes tsc prove no route reads a field
 * the local-claims path cannot supply. */
type VerifyFn<TUser> = (
  token: string,
) => Promise<{ data: { user: TUser | null }; error: { status?: number; code?: string } | null }>;

// Single-flight: concurrent verifications of the SAME token share one
// in-flight Supabase call instead of each firing /auth/v1/user (a burst of
// parallel requests from one stale client was the observed pattern).
// Keyed by token hash; the stored promise's user type is whatever the caller
// injected (one verifier per token in practice — the app has a single
// verifyAccessToken entry point).
const inFlight = new Map<string, Promise<unknown>>();

/** Test hook: reset single-flight state between smoke scenarios. */
export function _clearInFlight(): void {
  inFlight.clear();
}

/** Core verifier with an injectable Supabase call (unit-testable). */
export async function verifyAccessTokenWith<TUser>(
  getUserFn: VerifyFn<TUser>,
  token: string,
  nowMs = Date.now(),
): Promise<TUser | null> {
  if (!token) return null;
  if (!passesLocalPrecheck(token, nowMs)) return null;
  if (isKnownDeadToken(token, nowMs)) return null;

  const key = tokenKey(token);
  const existing = inFlight.get(key) as Promise<TUser | null> | undefined;
  if (existing) return existing;

  const task = (async () => {
    const { data, error } = await getUserFn(token);
    if (error || !data.user) {
      // Only cache rejections whose error CODE proves the session is dead.
      // 429/408/5xx/network errors or codeless 4xx stay retryable.
      if (error?.code && DEAD_TOKEN_ERROR_CODES.has(error.code)) {
        markTokenDead(token, nowMs);
      }
      return null;
    }
    return data.user;
  })();
  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}
