"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, X } from "lucide-react";
import {
  AUTH_ERROR_DIAG_CODES,
  AUTH_ERROR_EVENT,
  AUTH_ERROR_MESSAGES,
  AUTH_ERROR_STORAGE_KEY,
  buildLoginSupportMailto,
  getUserFacingAuthErrorFromUrl,
  stripAuthErrorNoticeParams,
  type UserFacingAuthErrorCode,
} from "@/lib/auth-error";

function isUserFacingAuthErrorCode(
  value: string | null,
): value is UserFacingAuthErrorCode {
  return value !== null && value in AUTH_ERROR_MESSAGES;
}

export default function AuthErrorNotice() {
  const [errorCode, setErrorCode] = useState<UserFacingAuthErrorCode | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const copyDiagCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard 미지원/권한 거부 — 코드는 화면에 그대로 보이므로 수동 입력 가능
    }
  };

  useEffect(() => {
    const url = new URL(window.location.href);
    const queryError = getUserFacingAuthErrorFromUrl(url);
    const storedError = sessionStorage.getItem(AUTH_ERROR_STORAGE_KEY);
    const initialError =
      queryError ??
      (isUserFacingAuthErrorCode(storedError) ? storedError : null);

    if (initialError) {
      queueMicrotask(() => setErrorCode(initialError));
      sessionStorage.removeItem(AUTH_ERROR_STORAGE_KEY);
    }

    // Next.js App Router re-syncs the canonical URL during hydration, clobbering
    // a synchronous replaceState here. Defer past the current frame so the strip
    // survives (verified on deployment: synchronous strip is reverted, rAF sticks).
    let stripRaf: number | null = null;
    if (stripAuthErrorNoticeParams(url)) {
      const strippedUrl = url.toString();
      stripRaf = window.requestAnimationFrame(() => {
        window.history.replaceState(window.history.state, "", strippedUrl);
      });
    }

    const handleAuthError = (event: Event) => {
      const code = (event as CustomEvent<string>).detail;
      if (isUserFacingAuthErrorCode(code)) {
        setErrorCode(code);
        sessionStorage.removeItem(AUTH_ERROR_STORAGE_KEY);
      }
    };

    window.addEventListener(AUTH_ERROR_EVENT, handleAuthError);
    return () => {
      window.removeEventListener(AUTH_ERROR_EVENT, handleAuthError);
      if (stripRaf !== null) window.cancelAnimationFrame(stripRaf);
    };
  }, []);

  if (!errorCode) return null;

  const diagCode = AUTH_ERROR_DIAG_CODES[errorCode];

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed left-4 right-4 top-[calc(var(--safe-area-inset-top,env(safe-area-inset-top))+1rem)] z-[12000] mx-auto max-w-lg rounded-2xl border border-red-500/30 bg-bg-secondary px-4 py-3 shadow-xl"
    >
      <div className="flex items-start gap-3">
        <p className="flex-1 text-sm leading-5 text-text-primary">
          {AUTH_ERROR_MESSAGES[errorCode]}
        </p>
        <button
          type="button"
          aria-label="안내 닫기"
          onClick={() => setErrorCode(null)}
          className="-mr-1 -mt-1 rounded-full p-2 text-text-tertiary"
        >
          <X size={18} />
        </button>
      </div>
      {diagCode && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => copyDiagCode(diagCode)}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 font-mono text-xs text-text-secondary"
            aria-label={`진단코드 ${diagCode} 복사`}
          >
            {diagCode}
            <Copy size={12} className="text-text-tertiary" />
            {copied && <span className="text-[10px] text-green-400">복사됨</span>}
          </button>
          <a
            href={buildLoginSupportMailto(diagCode)}
            className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary"
          >
            문의하기
          </a>
        </div>
      )}
    </div>
  );
}
