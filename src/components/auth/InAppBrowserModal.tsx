"use client";

import { motion, AnimatePresence } from "framer-motion";
import { X, ExternalLink, Copy, Check } from "lucide-react";
import { useEffect, useState } from "react";
import {
  detectInApp,
  openExternalBrowser,
  currentAbsoluteUrl,
  type InAppDetection,
} from "@/lib/detect-inapp";
import { useDialogFocus } from "@/lib/a11y/useDialogFocus";

interface InAppBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Called when the user picks "계속 시도" (override). They accept that login
   * may fail inside the WebView.
   */
  onContinueAnyway: () => void;
}

/**
 * Instructional modal shown when we detect the user is inside a social/chat
 * in-app WebView (Instagram, Threads, FB, KakaoTalk, NAVER app, Line, ...).
 *
 * UX goals:
 *   1. Explain why login might fail (very short, friendly)
 *   2. Offer a one-tap escape hatch when possible (Android/KakaoTalk)
 *   3. Otherwise offer a clear manual fallback (iOS) + copy-URL button
 *   4. Let the user dismiss and continue anyway (we should never hard-block)
 */
export default function InAppBrowserModal({
  isOpen,
  onClose,
  onContinueAnyway,
}: InAppBrowserModalProps) {
  const dialogRef = useDialogFocus(isOpen);
  const [detection, setDetection] = useState<InAppDetection | null>(null);
  const [copied, setCopied] = useState(false);
  // True after a scheme attempt timed out without the user actually leaving
  // this tab — i.e. the scheme silently failed. We surface the manual guide
  // block in that case even on platforms we normally treat as "can force-open".
  const [schemeFailed, setSchemeFailed] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setDetection(detectInApp());
    setSchemeFailed(false);
  }, [isOpen]);

  const handleOpenExternal = () => {
    if (!detection) return;
    const target = currentAbsoluteUrl();
    setSchemeFailed(false);
    const result = openExternalBrowser(target, detection, () => {
      // Scheme didn't escape the WebView within the timeout — fall back to
      // manual copy/guide without closing the modal.
      setSchemeFailed(true);
    });
    if (result === "fallback") {
      // No scheme was even attempted (iOS non-Kakao etc.). Manual guide is
      // already shown by default for this code path.
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(currentAbsoluteUrl());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Silently ignore — clipboard may be blocked inside some WebViews.
    }
  };

  const label = detection?.label ?? "이 앱";
  const isIos = detection?.os === "ios";
  // If we tried a scheme and it silently failed, treat this session as
  // "can't force-open" so the manual guide surfaces.
  const canForceOpen =
    !schemeFailed &&
    (detection?.kind === "kakaotalk" || detection?.os === "android");

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[10002] bg-black/70"
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            initial={{ y: "100%", opacity: 0.8 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: "100%", opacity: 0.8 }}
            transition={{ type: "spring", damping: 26, stiffness: 320 }}
            className="fixed bottom-0 left-0 right-0 z-[10003] mx-auto max-w-lg rounded-t-3xl bg-bg-secondary p-5 pb-safe"
            role="dialog"
            aria-modal="true"
            aria-label="외부 브라우저로 로그인 안내"
            ref={dialogRef}
            tabIndex={-1}
          >
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold text-text-primary">
                인앱 브라우저에서는 로그인이 원활하지 않을 수 있어요
              </h2>
              <button
                onClick={onClose}
                className="p-1 rounded-full hover:bg-bg-tertiary"
                aria-label="닫기"
              >
                <X size={20} className="text-text-tertiary" />
              </button>
            </div>

            <p className="text-sm text-text-secondary mb-5 leading-relaxed">
              <span className="text-text-primary font-medium">{label}</span>{" "}
              안에서 열었네요.
              <br />
              Safari 또는 Chrome에서 열면 더 안정적으로 로그인할 수 있어요.
            </p>

            {canForceOpen ? (
              <button
                onClick={handleOpenExternal}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl bg-brand-primary text-white font-medium text-sm transition-transform active:scale-[0.98] mb-3"
              >
                <ExternalLink size={18} />
                브라우저로 열기
              </button>
            ) : schemeFailed ? (
              <div className="rounded-xl bg-bg-tertiary/60 p-4 text-sm text-text-secondary leading-relaxed mb-3">
                <p className="text-text-primary font-medium mb-1">
                  자동 열기가 안 되네요
                </p>
                <p>
                  아래 주소 복사 버튼을 누르고 Safari 또는 Chrome에 붙여넣어주세요.
                </p>
              </div>
            ) : (
              <div className="rounded-xl bg-bg-tertiary/60 p-4 text-sm text-text-secondary leading-relaxed mb-3">
                {isIos ? (
                  <>
                    <p className="text-text-primary font-medium mb-1">
                      Safari로 여는 방법
                    </p>
                    <p>
                      브라우저 메뉴에서{" "}
                      <b>&quot;Safari로 열기&quot;</b>(또는{" "}
                      <b>&quot;외부 브라우저로 열기&quot;</b>)를 눌러주세요.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-text-primary font-medium mb-1">
                      외부 브라우저로 여는 방법
                    </p>
                    <p>
                      브라우저 메뉴에서{" "}
                      <b>&quot;다른 브라우저로 열기&quot;</b>를 눌러주세요.
                    </p>
                  </>
                )}
              </div>
            )}

            <button
              onClick={handleCopy}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-black/10 dark:border-white/10 text-sm text-text-secondary mb-3 transition-transform active:scale-[0.98]"
            >
              {copied ? (
                <>
                  <Check size={16} className="text-brand-primary" />
                  주소가 복사됐어요
                </>
              ) : (
                <>
                  <Copy size={16} />
                  주소 복사해서 붙여넣기
                </>
              )}
            </button>

            <button
              onClick={onContinueAnyway}
              className="w-full py-3 text-xs text-text-tertiary underline underline-offset-2"
            >
              여기서 계속
            </button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
