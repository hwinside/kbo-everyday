/** Allowlisted, non-identifying auth observations; never tokens or cookie values. */
export const AUTH_DIAGNOSTIC_SOURCE = "auth-session";
export const AUTH_DIAGNOSTIC_EVENTS = [
  "token-http-error", "token-network-error", "session-read-error",
  "initial-no-session", "storage-disappeared", "recovered",
  "session-read-pending",
] as const;
const ERROR_NAMES = ["AuthRetryableFetchError", "AuthApiError", "AuthSessionMissingError", "AuthUnknownError", "NavigatorLockAcquireTimeoutError", "TypeError", "AbortError", "OtherError"] as const;
const ERROR_CODES = ["refresh_token_already_used", "refresh_token_not_found", "session_not_found", "session_expired", "bad_jwt", "invalid_grant", "request_timeout", "over_request_rate_limit", "unexpected_failure", "other"] as const;
export type AuthStorageObservation = {
  auth: number | null;
  otherAuth: boolean | null;
  ga: boolean | null;
  marker: boolean | null;
};
export type AuthDiagnostic = {
  v: 1;
  boot: string | null;
  event: typeof AUTH_DIAGNOSTIC_EVENTS[number];
  os: "ios" | "android" | "other";
  initial: AuthStorageObservation;
  before: AuthStorageObservation;
  after: AuthStorageObservation;
  session: boolean | null;
  status: number | null;
  error: string | null;
  code: string | null;
};
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const exactKeys = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(x, k));
const maybeBool = (x: unknown) => x === null || typeof x === "boolean";
function storage(x: unknown): x is AuthStorageObservation {
  return record(x) && exactKeys(x, ["auth", "otherAuth", "ga", "marker"])
    && (x.auth === null || (Number.isInteger(x.auth) && Number(x.auth) >= 0 && Number(x.auth) <= 9))
    && maybeBool(x.otherAuth) && maybeBool(x.ga) && maybeBool(x.marker);
}
export function authErrorMetadata(error: unknown): Pick<AuthDiagnostic, "error" | "code" | "status"> {
  try {
    if (!record(error)) return { error: error == null ? null : "OtherError", code: null, status: null };
    const { name, code, status } = error;
    return {
      error: ERROR_NAMES.some(n => n === name) ? String(name) : "OtherError",
      code: code == null ? null : ERROR_CODES.some(c => c === code) ? String(code) : "other",
      status: Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599 ? Number(status) : null,
    };
  } catch { return { error: "OtherError", code: null, status: null }; }
}
export function parseAuthDiagnostic(value: unknown): AuthDiagnostic | null {
  if (!record(value) || !exactKeys(value, ["v", "boot", "event", "os", "initial", "before", "after", "session", "status", "error", "code"])) return null;
  if (value.v !== 1 || !(value.boot === null || (typeof value.boot === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.boot)))) return null;
  if (!AUTH_DIAGNOSTIC_EVENTS.some(e => e === value.event) || typeof value.os !== "string" || !["ios", "android", "other"].includes(value.os)) return null;
  if (![value.initial, value.before, value.after].every(storage) || !maybeBool(value.session)) return null;
  if (!(value.status === null || (Number.isInteger(value.status) && Number(value.status) >= 100 && Number(value.status) <= 599))) return null;
  if (!(value.error === null || ERROR_NAMES.some(e => e === value.error))) return null;
  if (!(value.code === null || ERROR_CODES.some(c => c === value.code))) return null;
  // Collector's existing message limit. Reject, never truncate JSON observations.
  if (JSON.stringify(value).length > 500) return null;
  return value as unknown as AuthDiagnostic;
}
