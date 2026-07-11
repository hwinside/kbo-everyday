"use client";

import { getPlatform, getVisitorId, getAppVersion } from "@/lib/admin/tracker";

/** Chunk/asset load failures are a deploy-skew symptom (stale client asking
 * for a purged build's chunk after a new deploy), not an app bug — callers
 * use this to auto-recover with a reload instead of showing an error page. */
export function isChunkLoadError(message: string): boolean {
  return /ChunkLoadError|Loading chunk .* failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    message,
  );
}

export type ClientErrorSource =
  | "window-error"
  | "unhandledrejection"
  | "error-boundary"
  | "global-error-boundary";

// A crashing render loop or a rejection storm can fire hundreds of identical
// events; cap what a single page session may send.
const MAX_REPORTS_PER_SESSION = 5;
let reportsSent = 0;
const seenMessages = new Set<string>();

export function reportClientError(input: {
  message: string;
  stack?: string | null;
  source: ClientErrorSource;
  digest?: string | null;
}): void {
  if (typeof window === "undefined") return;
  if (reportsSent >= MAX_REPORTS_PER_SESSION) return;

  const message = String(input.message || "unknown").slice(0, 500);
  if (seenMessages.has(message)) return;
  seenMessages.add(message);
  reportsSent += 1;

  // The reporter itself runs inside error paths (including the global
  // unhandledrejection handler) — any throw here would re-enter those
  // handlers, so every step gets a safe fallback and the whole body is
  // wrapped. `safe()` covers storage/crypto denials (private mode, webview
  // quirks); the outer try covers anything else.
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  void (async () => {
    try {
      let appVersion: string | null = null;
      try {
        appVersion = await getAppVersion();
      } catch {
        appVersion = null;
      }

      const body = JSON.stringify({
        message,
        stack: safe(
          () => (input.stack ? String(input.stack).slice(0, 4000) : null),
          null,
        ),
        source: input.source,
        digest: input.digest || null,
        path: safe(() => window.location.pathname, null),
        platform: safe(() => getPlatform(), null),
        appVersion,
        userAgent: safe(() => navigator.userAgent.slice(0, 512), null),
        visitorId: safe(() => getVisitorId() || null, null),
        isChunkError: isChunkLoadError(message),
      });
      const url = "/api/telemetry/client-error";

      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon(url, blob)) return;
      }
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* telemetry must never throw */
    }
  })();
}
