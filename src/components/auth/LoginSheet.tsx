"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { motion, AnimatePresence } from "framer-motion";
import { X, Check } from "lucide-react";
import { signInWithApple, signInWithGoogle, signInWithKakao, signInWithNaver } from "@/lib/supabase/auth";
import { useAuth } from "@/lib/supabase/AuthContext";
import { useDialogFocus } from "@/lib/a11y/useDialogFocus";
import { detectInApp } from "@/lib/detect-inapp";
import InAppBrowserModal from "./InAppBrowserModal";

interface LoginSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

type Provider = "apple" | "naver" | "kakao" | "google";

export default function LoginSheet({ isOpen, onClose }: LoginSheetProps) {
  const dialogRef = useDialogFocus(isOpen);
  const { user } = useAuth();
  const [inAppModalOpen, setInAppModalOpen] = useState(false);
  // EULA(이용약관) 동의 게이트 — Apple 1.2: 가입/로그인 전 약관 동의 필수.
  const [agreed, setAgreed] = useState(false);
  const [agreeError, setAgreeError] = useState(false);
  // Remember which provider the user clicked so "계속 시도" in the modal can
  // still fall through to the provider they originally chose.
  const pendingProviderRef = useRef<Provider | null>(null);
  // position:fixed 오버레이가 transform 조상(예: 뉴스 캐러셀 translateX)에 갇히지 않도록
  // document.body로 포털한다. CommentSheet와 동일한 SSR 마운트 가드 패턴.
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInAppModalOpen(false);
      setAgreed(false);
      setAgreeError(false);
      pendingProviderRef.current = null;
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && user) {
      onClose();
    }
  }, [isOpen, onClose, user]);

  const runProvider = useCallback((provider: Provider) => {
    if (provider === "apple") return signInWithApple();
    if (provider === "naver") return signInWithNaver();
    if (provider === "kakao") return signInWithKakao();
    return signInWithGoogle();
  }, []);

  const handleProviderClick = useCallback(
    (provider: Provider) => {
      // 약관 미동의 시 로그인 차단(EULA 게이트).
      if (!agreed) {
        setAgreeError(true);
        return;
      }
      const detection = detectInApp();
      if (detection.isInApp) {
        pendingProviderRef.current = provider;
        setInAppModalOpen(true);
        return;
      }
      runProvider(provider);
    },
    [agreed, runProvider],
  );

  const handleContinueAnyway = useCallback(() => {
    const provider = pendingProviderRef.current;
    setInAppModalOpen(false);
    pendingProviderRef.current = null;
    if (provider) runProvider(provider);
  }, [runProvider]);

  const overlay = (
    <>
      <AnimatePresence>
        {isOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[10000] bg-black/60"
              onClick={onClose}
              aria-hidden
            />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="fixed bottom-0 left-0 right-0 z-[10001] mx-auto max-w-lg rounded-t-3xl bg-bg-secondary p-5 pb-safe"
              role="dialog"
              aria-modal="true"
              aria-label="로그인"
              ref={dialogRef}
              tabIndex={-1}
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-bold text-text-primary">로그인</h2>
                <button onClick={onClose} aria-label="닫기" className="p-1 rounded-full hover:bg-bg-tertiary">
                  <X size={20} className="text-text-tertiary" />
                </button>
              </div>

              <p className="text-sm text-text-secondary mb-4">
                로그인하면 채팅, 게시판을 이용할 수 있어요
              </p>

              {/* EULA 동의 게이트 — Apple 1.2: 가입/로그인 전 약관 동의 + 무관용 원칙 명시. */}
              <div className="mb-5">
                <div className="flex items-start gap-2.5">
                  <button
                    type="button"
                    onClick={() => { setAgreed(v => !v); setAgreeError(false); }}
                    aria-pressed={agreed}
                    aria-label="이용약관 및 개인정보처리방침 동의"
                    className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border transition-colors ${
                      agreed ? "bg-accent border-accent" : agreeError ? "border-red-500" : "border-text-tertiary"
                    }`}
                  >
                    {agreed && <Check size={14} className="text-white" />}
                  </button>
                  <p className="text-[12px] leading-snug text-text-secondary">
                    (만 14세 이상) <Link href="/terms" className="underline underline-offset-2">이용약관</Link> 및{" "}
                    <Link href="/privacy" className="underline underline-offset-2">개인정보처리방침</Link>에 동의합니다.
                    크보팬은 욕설·비방 등 불쾌한 콘텐츠와 악성 이용자에 대해 무관용 원칙을 적용합니다.
                  </p>
                </div>
                {agreeError && (
                  <p className="mt-1.5 ml-7 text-[11px] text-red-500">약관에 동의해야 로그인할 수 있어요</p>
                )}
              </div>

              <div className={`space-y-3 transition-opacity ${agreed ? "" : "opacity-50"}`}>
                {/* 네이버 로그인 — 검수 승인 완료 (2026-04-17) */}
                <button
                  onClick={() => handleProviderClick("naver")}
                  className="w-full flex items-center justify-center gap-3 py-3.5 rounded-xl font-medium text-sm transition-transform active:scale-[0.98]"
                  style={{ backgroundColor: "#03C75A", color: "#FFFFFF" }}
                >
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <path d="M13.56 10.7L6.17 0H0v20h6.44V9.3L13.83 20H20V0h-6.44v10.7z" fill="#FFFFFF" transform="scale(0.8) translate(2.5,2.5)"/>
                  </svg>
                  네이버로 시작하기
                </button>

                <button
                  onClick={() => handleProviderClick("kakao")}
                  className="w-full flex items-center justify-center gap-3 py-3.5 rounded-xl font-medium text-sm transition-transform active:scale-[0.98]"
                  style={{ backgroundColor: "#FEE500", color: "#191919" }}
                >
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <path d="M10 3C5.58 3 2 5.79 2 9.25C2 11.43 3.47 13.34 5.69 14.39L4.85 17.46C4.78 17.7 5.07 17.89 5.28 17.74L8.92 15.32C9.27 15.36 9.63 15.39 10 15.39C14.42 15.39 18 12.6 18 9.14C18 5.79 14.42 3 10 3Z" fill="#191919"/>
                  </svg>
                  카카오로 시작하기
                </button>

                <button
                  onClick={() => handleProviderClick("google")}
                  className="w-full flex items-center justify-center gap-3 py-3.5 rounded-xl font-medium text-sm border border-black/10 dark:border-white/10 bg-white text-gray-800 transition-transform active:scale-[0.98]"
                >
                  <svg width="20" height="20" viewBox="0 0 20 20">
                    <path d="M19.6 10.23c0-.68-.06-1.36-.17-2.02H10v3.83h5.38a4.6 4.6 0 01-2 3.02v2.5h3.24c1.89-1.74 2.98-4.3 2.98-7.33z" fill="#4285F4"/>
                    <path d="M10 20c2.7 0 4.96-.9 6.62-2.44l-3.24-2.5c-.9.6-2.04.95-3.38.95-2.6 0-4.8-1.76-5.58-4.12H1.07v2.58A9.99 9.99 0 0010 20z" fill="#34A853"/>
                    <path d="M4.42 11.89A6.01 6.01 0 014.1 10c0-.66.11-1.3.32-1.89V5.53H1.07A9.99 9.99 0 000 10c0 1.61.39 3.14 1.07 4.47l3.35-2.58z" fill="#FBBC05"/>
                    <path d="M10 3.96c1.47 0 2.78.5 3.82 1.5l2.86-2.87C14.96.99 12.7 0 10 0A9.99 9.99 0 001.07 5.53l3.35 2.58C5.2 5.72 7.4 3.96 10 3.96z" fill="#EA4335"/>
                  </svg>
                  Google로 시작하기
                </button>

                <button
                  onClick={() => handleProviderClick("apple")}
                  className="w-full flex items-center justify-center gap-3 py-3.5 rounded-xl font-medium text-sm transition-transform active:scale-[0.98] bg-black text-white dark:bg-white dark:text-black"
                >
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M15.07 10.41c-.01-1.63.87-2.87 2.64-3.78-.98-1.42-2.47-2.2-4.43-2.36-1.86-.16-3.89 1.1-4.64 1.1-.79 0-2.52-1.04-3.83-1.04C2.52 4.37 0 6.67 0 10.6c0 1.16.21 2.36.63 3.6.56 1.63 2.58 5.63 4.7 5.56 1.1-.02 1.88-.79 3.52-.79 1.59 0 2.31.79 3.52.77 2.15-.04 3.95-3.65 4.49-5.29-2.87-1.37-2.79-4.01-2.79-4.04zM12.48 2.81C13.67 1.4 13.56 0.11 13.52 0c-1.13.07-2.44.78-3.19 1.67-.82.96-1.3 2.13-1.2 3.44 1.23.09 2.36-.54 3.35-2.3z"/>
                  </svg>
                  Apple로 시작하기
                </button>
              </div>

            </motion.div>
          </>
        )}
      </AnimatePresence>

      <InAppBrowserModal
        isOpen={inAppModalOpen}
        onClose={() => {
          setInAppModalOpen(false);
          pendingProviderRef.current = null;
        }}
        onContinueAnyway={handleContinueAnyway}
      />
    </>
  );

  if (!mounted) return null;
  return createPortal(overlay, document.body);
}
