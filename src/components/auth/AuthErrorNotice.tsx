"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  AUTH_ERROR_EVENT,
  AUTH_ERROR_MESSAGES,
  AUTH_ERROR_STORAGE_KEY,
  getUserFacingAuthErrorFromUrl,
  type UserFacingAuthErrorCode,
} from "@/lib/auth-error";

function isUserFacingAuthErrorCode(
  value: string | null,
): value is UserFacingAuthErrorCode {
  return value !== null && value in AUTH_ERROR_MESSAGES;
}

export default function AuthErrorNotice() {
  const [errorCode, setErrorCode] = useState<UserFacingAuthErrorCode | null>(null);

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

    if (url.searchParams.has("auth_error")) {
      url.searchParams.delete("auth_error");
      window.history.replaceState(window.history.state, "", url.toString());
    }

    const handleAuthError = (event: Event) => {
      const code = (event as CustomEvent<string>).detail;
      if (isUserFacingAuthErrorCode(code)) {
        setErrorCode(code);
        sessionStorage.removeItem(AUTH_ERROR_STORAGE_KEY);
      }
    };

    window.addEventListener(AUTH_ERROR_EVENT, handleAuthError);
    return () => window.removeEventListener(AUTH_ERROR_EVENT, handleAuthError);
  }, []);

  if (!errorCode) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed left-4 right-4 top-[calc(var(--safe-area-inset-top,env(safe-area-inset-top))+1rem)] z-[12000] mx-auto flex max-w-lg items-start gap-3 rounded-2xl border border-red-500/30 bg-bg-secondary px-4 py-3 shadow-xl"
    >
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
  );
}
