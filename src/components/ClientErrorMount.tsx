"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-error-report";

/** Reports uncaught window errors and unhandled promise rejections so
 * intermittent client crashes leave a trace (admin_client_errors) instead of
 * vanishing with the user's error screen. Render-path errors are reported by
 * error.tsx / global-error.tsx; this catches everything outside React render
 * (event handlers, async code, script/chunk load failures). */
export function ClientErrorMount() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      reportClientError({
        message: event.message || "window error",
        stack: event.error instanceof Error ? event.error.stack : null,
        source: "window-error",
      });
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      reportClientError({
        message:
          reason instanceof Error
            ? reason.message
            : typeof reason === "string"
              ? reason
              : "unhandled rejection",
        stack: reason instanceof Error ? reason.stack : null,
        source: "unhandledrejection",
      });
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
