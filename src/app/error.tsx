"use client";

import { useEffect } from "react";
import { isChunkLoadError, reportClientError } from "@/lib/client-error-report";

// One auto-reload per window guards against a reload loop when the fresh
// build itself crashes; sessionStorage survives the reload we trigger.
const RELOAD_FLAG = "kbo_chunk_reload_at";
const RELOAD_WINDOW_MS = 60 * 1000;

function tryChunkErrorReload(message: string): boolean {
  if (!isChunkLoadError(message)) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_FLAG) || 0);
    if (Date.now() - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError({
      message: error.message,
      stack: error.stack,
      source: "error-boundary",
      digest: error.digest,
    });
    tryChunkErrorReload(error.message || "");
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-bg-primary px-6 text-center">
      <p className="text-4xl">⚾</p>
      <h1 className="mt-4 text-lg font-bold text-text-primary">
        일시적인 오류가 발생했어요
      </h1>
      <p className="mt-2 text-sm text-text-secondary">
        잠시 후 다시 시도해 주세요. 문제가 계속되면 앱을 완전히 닫았다가 다시
        열어주세요.
      </p>
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white"
        >
          다시 시도
        </button>
        <button
          type="button"
          onClick={() => {
            window.location.href = "/";
          }}
          className="rounded-full bg-bg-tertiary px-5 py-2.5 text-sm font-semibold text-text-primary"
        >
          홈으로
        </button>
      </div>
    </div>
  );
}
