"use client";

import { useEffect, useMemo, useState } from "react";
import { useDialogFocus } from "@/lib/a11y/useDialogFocus";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Pencil, X } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { NICKNAME_INPUT_PLACEHOLDER, NICKNAME_MAX_LENGTH, validateNickname } from "@/lib/validation/nickname";

interface NicknameStatus {
  nickname: string;
  used: number;
  remaining: number;
  limit: number;
  windowDays: number;
  resetAt: string | null;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentNickname: string;
  status: NicknameStatus | null;
  onSaved: () => Promise<void> | void;
}

function useBodyScrollLock(isOpen: boolean) {
  useEffect(() => {
    if (!isOpen) return;

    const scrollY = window.scrollY;
    const { style } = document.body;
    style.position = "fixed";
    style.top = `-${scrollY}px`;
    style.width = "100%";
    style.overflow = "hidden";

    return () => {
      style.position = "";
      style.top = "";
      style.width = "";
      style.overflow = "";
      window.scrollTo(0, scrollY);
    };
  }, [isOpen]);
}

function formatResetAt(resetAt: string | null) {
  if (!resetAt) return null;

  const date = new Date(resetAt);

  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export default function NicknameEditSheet({ isOpen, onClose, currentNickname, status, onSaved }: Props) {
  const dialogRef = useDialogFocus(isOpen);
  const [nickname, setNickname] = useState(currentNickname);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const resetAtLabel = useMemo(() => formatResetAt(status?.resetAt ?? null), [status?.resetAt]);

  useBodyScrollLock(isOpen);

  useEffect(() => {
    if (!isOpen) return;
    setNickname(currentNickname);
    setError("");
    setSaving(false);
  }, [isOpen, currentNickname]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  const handleSave = async () => {
    const trimmed = nickname.trim();

    const validationError = validateNickname(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError("");

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

      const res = await fetch("/api/me/nickname", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ nickname: trimmed }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(json.error || "닉네임 변경에 실패했습니다");
        setSaving(false);
        return;
      }

      await onSaved();
      setSaving(false);
      onClose();
    } catch {
      setError("닉네임 변경에 실패했습니다");
      setSaving(false);
    }
  };

  if (typeof window === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-[60] bg-black/60"
            aria-hidden
          />

          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed bottom-0 left-0 right-0 z-[60] mx-auto max-w-lg rounded-t-3xl bg-bg-secondary border-t border-black/10 dark:border-white/10"
            role="dialog"
            aria-modal="true"
            aria-label="닉네임 변경"
            ref={dialogRef}
            tabIndex={-1}
          >
            <div className="mx-auto mt-3 mb-2 h-1 w-10 rounded-full bg-text-tertiary/30" />

            <div className="flex items-center justify-between px-5 mb-3">
              <h2 className="text-lg font-bold text-text-primary">닉네임 변경</h2>
              <button onClick={onClose} aria-label="닫기" className="rounded-full p-1 hover:bg-bg-tertiary transition-colors">
                <X size={22} className="text-text-secondary" />
              </button>
            </div>

            <div className="px-5 pb-[calc(20px+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]">
              <div className="rounded-2xl bg-bg-glass p-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-full bg-accent/15 p-2 text-accent">
                    <Pencil size={16} />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-text-primary">마이페이지에서 바로 변경돼요</p>
                    <p className="mt-1 text-xs text-text-secondary">최근 {status?.windowDays ?? 30}일 기준 {status?.limit ?? 2}번까지 변경할 수 있어요.</p>
                    <p className="mt-1 text-xs text-text-tertiary">
                      남은 횟수: <span className="font-semibold text-text-primary">{status?.remaining ?? "-"}회</span>
                      {resetAtLabel ? <span className="ml-2">다음 복구: {resetAtLabel}</span> : null}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-4">
                <label className="mb-2 block text-sm font-medium text-text-primary">새 닉네임</label>
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => {
                    setNickname(e.target.value);
                    setError("");
                  }}
                  maxLength={Math.max(NICKNAME_MAX_LENGTH, currentNickname.length)}
                  placeholder={NICKNAME_INPUT_PLACEHOLDER}
                  className="w-full rounded-2xl border border-black/10 dark:border-white/10 bg-bg-tertiary px-4 py-3 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
                />
                <p className="mt-2 text-xs text-text-tertiary">2~8자 · 한글, 영문, 숫자만 사용 가능</p>
                {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
              </div>

              <div className="mt-5 flex gap-3">
                <button
                  onClick={onClose}
                  className="flex-1 rounded-2xl bg-bg-tertiary py-3 text-sm font-semibold text-text-secondary"
                >
                  취소
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || nickname.trim().length < 2}
                  className="flex-1 rounded-2xl bg-accent py-3 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
                >
                  {saving ? "저장 중..." : "변경하기"}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
