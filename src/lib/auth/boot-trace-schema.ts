import { parseAuthDiagnostic, type AuthDiagnostic, type AuthStorageObservation } from "./session-diagnostic-schema";

export const AUTH_BOOT_SOURCE = "auth-boot";
export const AUTH_BOOT_SERVER_SOURCE = "auth-boot-server";
export const AUTH_BOOT_TIMING = "kbo-auth-boot";
export const isBootTraceId = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export type BootOutcome = "published" | "superseded" | "retryable-error" | "error";
export type AuthBootDiagnostic = Omit<AuthDiagnostic, "event" | "before"> & {
  boot: string;
  event: "boot-result" | "boot-pending";
  outcome: BootOutcome | "pending";
  cookieSession: boolean | null;
};

/** Only a same-document, server-generated timing entry can join the two sources.
 * No cookies, localStorage, URL, incoming request header, or persistent identity.
 * Unsupported/ambiguous timing means unlinked, never a guessed match. */
export function readBootTraceId(perf: Pick<Performance, "getEntriesByType">): string | null {
  try {
    const navigations = perf.getEntriesByType("navigation");
    if (navigations.length !== 1) return null;
    const timing = (navigations[0] as PerformanceNavigationTiming).serverTiming;
    if (!Array.isArray(timing)) return null;
    const entries = timing.filter(entry => entry.name === AUTH_BOOT_TIMING);
    return entries.length === 1 && isBootTraceId(entries[0].description) ? entries[0].description : null;
  } catch { return null; }
}

export function parseAuthBootDiagnostic(value: unknown): AuthBootDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  const keys = ["v", "boot", "event", "os", "initial", "after", "session", "status", "error", "code", "outcome", "cookieSession"];
  if (Object.keys(d).length !== keys.length || !keys.every(k => Object.hasOwn(d, k)) || !isBootTraceId(d.boot)) return null;
  if (!["published", "superseded", "retryable-error", "error", "pending"].includes(String(d.outcome))) return null;
  if (d.event !== "boot-result" && d.event !== "boot-pending") return null;
  if ((d.event === "boot-pending") !== (d.outcome === "pending")) return null;
  if (!(d.cookieSession === null || typeof d.cookieSession === "boolean")) return null;
  // Reuse the existing storage and error allowlists (including unknown != absent).
  // The small before snapshot is not transmitted or stored by this source.
  const before: AuthStorageObservation = { auth: null, otherAuth: null, ga: null, marker: null };
  const checked = parseAuthDiagnostic({
    v: d.v, boot: d.boot, event: "session-read-error", os: d.os,
    initial: d.initial, before, after: d.after, session: d.session,
    status: d.status, error: d.error, code: d.code,
  });
  if (!checked || JSON.stringify(d).length > 500) return null;
  return d as unknown as AuthBootDiagnostic;
}
