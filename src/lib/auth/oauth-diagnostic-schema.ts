/** Closed, non-identifying OAuth observations. Never accept URLs, tokens or raw errors. */
export const OAUTH_DIAGNOSTIC_SOURCE = "auth-oauth";
export const OAUTH_STAGES = ["bridge-ready", "bridge-failed", "listener-ready", "listener-skipped", "start", "browser-open", "callback", "exchange-start", "session-ready", "failed", "pending", "duplicate", "profile-required", "profile-ready"] as const;
export const OAUTH_PROVIDERS = ["google", "naver", "apple", "kakao", "unknown"] as const;
export const OAUTH_FAILURES = ["none", "network", "pkce", "expired", "rate-limit", "lock", "provider", "other"] as const;
export type OAuthProvider = typeof OAUTH_PROVIDERS[number];
export type OAuthDiagnostic = {
  v: 1; attempt: string | null; provider: OAuthProvider;
  stage: typeof OAUTH_STAGES[number]; failure: typeof OAUTH_FAILURES[number];
  coreNative: boolean; runtimeNative: boolean; listener: boolean; bridge: boolean;
};
export function parseOAuthDiagnostic(value: unknown): OAuthDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const x = value as Record<string, unknown>;
  const keys = ["v", "attempt", "provider", "stage", "failure", "coreNative", "runtimeNative", "listener", "bridge"];
  if (Object.keys(x).length !== keys.length || !keys.every(k => Object.hasOwn(x, k))) return null;
  if (x.v !== 1 || !(x.attempt === null || (typeof x.attempt === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x.attempt)))) return null;
  if (!OAUTH_PROVIDERS.some(v => v === x.provider) || !OAUTH_STAGES.some(v => v === x.stage) || !OAUTH_FAILURES.some(v => v === x.failure)) return null;
  if (![x.coreNative, x.runtimeNative, x.listener, x.bridge].every(v => typeof v === "boolean")) return null;
  return x as OAuthDiagnostic;
}
export function oauthFailure(error: unknown): OAuthDiagnostic["failure"] {
  // Read only SDK structured fields. Raw messages may contain credentials/URLs.
  try {
    const x = error as { name?: unknown; code?: unknown; status?: unknown } | null;
    if (!x) return "other";
    if (x.name === "AuthPKCEGrantCodeExchangeError") return "pkce";
    if (x.name === "NavigatorLockAcquireTimeoutError") return "lock";
    if (x.name === "TypeError" || x.name === "AuthRetryableFetchError") return "network";
    if (["bad_code_verifier", "flow_state_not_found", "validation_failed"].includes(String(x.code))) return "pkce";
    if (x.code === "flow_state_expired" || x.code === "otp_expired") return "expired";
    if (x.status === 429 || x.code === "over_request_rate_limit") return "rate-limit";
  } catch { /* an observer must not break authentication */ }
  return "other";
}
