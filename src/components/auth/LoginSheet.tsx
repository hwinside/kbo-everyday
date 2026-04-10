"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { signInWithGoogle, signInWithKakao } from "@/lib/supabase/auth";

interface LoginSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function LoginSheet({ isOpen, onClose }: LoginSheetProps) {
  const [agreed, setAgreed] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setAgreed(false);
    }
  }, [isOpen]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[90] bg-black/60"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed bottom-0 left-0 right-0 z-[91] mx-auto max-w-lg rounded-t-3xl bg-bg-secondary p-6 pb-safe"
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-text-primary">로그인</h2>
              <button onClick={onClose} className="p-1 rounded-full hover:bg-bg-tertiary">
                <X size={20} className="text-text-tertiary" />
              </button>
            </div>

            <p className="text-sm text-text-secondary mb-6">
              로그인하면 예측, 채팅, 게시판을 이용할 수 있어요
            </p>

            <label className="flex items-start gap-3 rounded-2xl border border-border bg-bg-tertiary/70 p-4">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-1 accent-accent"
              />
              <span className="text-xs leading-6 text-text-secondary">
                [필수] <Link href="/terms" className="font-semibold text-text-primary underline underline-offset-2">이용약관</Link> 및{" "}
                <Link href="/privacy" className="font-semibold text-text-primary underline underline-offset-2">개인정보처리방침</Link>에 동의합니다.
              </span>
            </label>

            <div className="space-y-3">
              <button
                onClick={() => signInWithKakao()}
                disabled={!agreed}
                className="w-full flex items-center justify-center gap-3 py-3.5 rounded-xl font-medium text-sm transition-transform active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100"
                style={{ backgroundColor: "#FEE500", color: "#191919" }}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M10 3C5.58 3 2 5.79 2 9.25C2 11.43 3.47 13.34 5.69 14.39L4.85 17.46C4.78 17.7 5.07 17.89 5.28 17.74L8.92 15.32C9.27 15.36 9.63 15.39 10 15.39C14.42 15.39 18 12.6 18 9.14C18 5.79 14.42 3 10 3Z" fill="#191919"/>
                </svg>
                카카오로 시작하기
              </button>

              <button
                onClick={() => signInWithGoogle()}
                disabled={!agreed}
                className="w-full flex items-center justify-center gap-3 py-3.5 rounded-xl font-medium text-sm border border-black/10 dark:border-white/10 bg-white text-gray-800 transition-transform active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100"
              >
                <svg width="20" height="20" viewBox="0 0 20 20">
                  <path d="M19.6 10.23c0-.68-.06-1.36-.17-2.02H10v3.83h5.38a4.6 4.6 0 01-2 3.02v2.5h3.24c1.89-1.74 2.98-4.3 2.98-7.33z" fill="#4285F4"/>
                  <path d="M10 20c2.7 0 4.96-.9 6.62-2.44l-3.24-2.5c-.9.6-2.04.95-3.38.95-2.6 0-4.8-1.76-5.58-4.12H1.07v2.58A9.99 9.99 0 0010 20z" fill="#34A853"/>
                  <path d="M4.42 11.89A6.01 6.01 0 014.1 10c0-.66.11-1.3.32-1.89V5.53H1.07A9.99 9.99 0 000 10c0 1.61.39 3.14 1.07 4.47l3.35-2.58z" fill="#FBBC05"/>
                  <path d="M10 3.96c1.47 0 2.78.5 3.82 1.5l2.86-2.87C14.96.99 12.7 0 10 0A9.99 9.99 0 001.07 5.53l3.35 2.58C5.2 5.72 7.4 3.96 10 3.96z" fill="#EA4335"/>
                </svg>
                Google로 시작하기
              </button>
            </div>

            <p className="text-[11px] text-text-tertiary text-center mt-4">
              동의 후 로그인하면 커뮤니티, 예측, 쪽지 기능을 이용할 수 있어요.
            </p>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
