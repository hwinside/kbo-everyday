"use client";

import { useEffect } from "react";
import { isChunkLoadError, reportClientError } from "@/lib/client-error-report";

// global-error replaces the root layout entirely, so globals.css/Tailwind are
// not available here — styles must be inline. Keeps to the forced-dark base
// (#0A0A0B) with a light-scheme override via the embedded <style>.
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    reportClientError({
      message: error.message,
      stack: error.stack,
      source: "global-error-boundary",
      digest: error.digest,
    });
    if (isChunkLoadError(error.message || "")) {
      try {
        const last = Number(sessionStorage.getItem("kbo_chunk_reload_at") || 0);
        if (Date.now() - last >= 60 * 1000) {
          sessionStorage.setItem("kbo_chunk_reload_at", String(Date.now()));
          window.location.reload();
        }
      } catch {
        /* ignore */
      }
    }
  }, [error]);

  return (
    <html lang="ko">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: "0 24px",
          background: "#0A0A0B",
          color: "#FFFFFF",
          fontFamily:
            "Pretendard Variable, -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
        }}
      >
        <style>{`
          @media (prefers-color-scheme: light) {
            body { background: #F2F2F7 !important; color: #1C1C1E !important; }
          }
        `}</style>
        <p style={{ fontSize: 36, margin: 0 }}>⚾</p>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: "16px 0 0" }}>
          일시적인 오류가 발생했어요
        </h1>
        <p style={{ fontSize: 14, opacity: 0.65, margin: "8px 0 0" }}>
          잠시 후 다시 시도해 주세요.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop: 24,
            border: 0,
            borderRadius: 9999,
            padding: "10px 20px",
            fontSize: 14,
            fontWeight: 600,
            color: "#FFFFFF",
            background: "#FF453A",
            cursor: "pointer",
          }}
        >
          새로고침
        </button>
      </body>
    </html>
  );
}
