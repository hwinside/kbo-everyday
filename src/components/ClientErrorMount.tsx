"use client";

import { useEffect } from "react";
import {
  maybeReloadForChunkError,
  reportClientError,
} from "@/lib/client-error-report";

/** Reports uncaught window errors and unhandled promise rejections so
 * intermittent client crashes leave a trace (admin_client_errors) instead of
 * vanishing with the user's error screen. Render-path errors are reported by
 * error.tsx / global-error.tsx; this catches everything outside React render
 * (event handlers, async code, script/chunk load failures).
 *
 * A chunk-load failure here is usually a soft navigation aborting on a stale
 * build (deploy skew) — the router swallows it, so it never reaches the error
 * boundary and the page silently stays put (e.g. admin menu "won't move").
 * Self-heal with the same guarded reload the boundaries use, after reporting. */
export function ClientErrorMount() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const message = event.message || "window error";
      reportClientError({
        message,
        stack: event.error instanceof Error ? event.error.stack : null,
        source: "window-error",
      });
      maybeReloadForChunkError(message);
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "unhandled rejection";
      reportClientError({
        message,
        stack: reason instanceof Error ? reason.stack : null,
        source: "unhandledrejection",
      });
      maybeReloadForChunkError(message);
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
