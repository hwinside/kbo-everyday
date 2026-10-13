/** Last observation in this origin's storage, NOT a device ID or proof of exit,
 * deletion, or a particular OS event. Missing/unreadable must stay distinct. */
export type AuthExitRecord = {
  v: 1;
  at: number; // Unix minute, not millisecond precision.
  kind: "hidden" | "pagehide" | "session" | "refresh" | "logout";
  authChunks: number | null;
  marker: boolean | null;
  lastRefresh: "ok" | "fail" | "none";
  lastRefreshAt: number | null;
};
export type PreviousAuthExit = {
  state: "present" | "missing" | "unreadable" | "invalid" | "expired" | "unsupported";
  record: AuthExitRecord | null;
};
export const AUTH_EXIT_MAX_CHARS = 384;
export const AUTH_EXIT_MAX_AGE_MINUTES = 30 * 24 * 60;
export const AUTH_DIAGNOSTIC_MAX_CHARS = 1000;
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const keys = (x: Record<string, unknown>, names: string[]) => Object.keys(x).length === names.length && names.every(k => Object.hasOwn(x, k));
const minute = (x: unknown): x is number => Number.isInteger(x) && Number(x) > 0 && Number(x) <= 100_000_000;

export function parseAuthExitRecord(value: unknown): AuthExitRecord | null {
  if (!object(value) || !keys(value, ["v", "at", "kind", "authChunks", "marker", "lastRefresh", "lastRefreshAt"])) return null;
  if (value.v !== 1 || !minute(value.at) || typeof value.kind !== "string" || !["hidden", "pagehide", "session", "refresh", "logout"].includes(value.kind)) return null;
  if (!(value.authChunks === null || (Number.isInteger(value.authChunks) && Number(value.authChunks) >= 0 && Number(value.authChunks) <= 9))) return null;
  if (!(value.marker === null || typeof value.marker === "boolean") || typeof value.lastRefresh !== "string" || !["ok", "fail", "none"].includes(value.lastRefresh)) return null;
  if (value.lastRefresh === "none" ? value.lastRefreshAt !== null : !minute(value.lastRefreshAt) || value.lastRefreshAt > value.at) return null;
  if (JSON.stringify(value).length > AUTH_EXIT_MAX_CHARS) return null;
  return value as unknown as AuthExitRecord;
}

export function isPreviousAuthExit(value: unknown): value is PreviousAuthExit {
  if (!object(value) || !keys(value, ["state", "record"])) return false;
  if (value.state === "present") return parseAuthExitRecord(value.record) !== null;
  return typeof value.state === "string" && ["missing", "unreadable", "invalid", "expired", "unsupported"].includes(value.state) && value.record === null;
}
