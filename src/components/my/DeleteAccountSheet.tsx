"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, AlertTriangle } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { useDialogFocus } from "@/lib/a11y/useDialogFocus";

interface DeleteAccountSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function DeleteAccountSheet({
  isOpen,
  onClose,
}: DeleteAccountSheetProps) {
  const dialogRef = useDialogFocus(isOpen);
  const [confirmText, setConfText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { signOut } = useAuth();

  const canDelete = confirmText === "탈퇴";

  async function handleDelete() {
    if (!canDelete || isDeleting) return;
    setIsDeleting(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/delete-account", { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "계정 삭제에 실패했습니다");
      }
      await signOut();
      window.location.href = "/";
    } catch (e) {
      setError(e instanceof Error ? e.message : "오류가 발생했습니다");
      setIsDeleting(false);
    }
  }

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
            aria-hidden
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed bottom-0 left-0 right-0 z-[91] mx-auto max-w-lg rounded-t-3xl bg-bg-secondary p-5 pb-safe"
            role="dialog"
            aria-modal="true"
            aria-label="계정 삭제"
            ref={dialogRef}
            tabIndex={-1}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-red-500 flex items-center gap-2">
                <AlertTriangle size={20} />
                계정 삭제
              </h2>
              <button
                onClick={onClose}
                aria-label="닫기"
                className="p-1 rounded-full hover:bg-bg-tertiary"
              >
                <X size={20} className="text-text-tertiary" />
              </button>
            </div>

            <div className="space-y-3 mb-5">
              <p className="text-sm text-text-secondary">
                계정을 삭제하면 다음 데이터가 <strong>영구적으로 삭제</strong>
                됩니다:
              </p>
              <ul className="text-sm text-text-tertiary space-y-1 ml-4 list-disc">
                <li>프로필 정보 (닉네임, 아바타, 응원팀)</li>
                <li>작성한 게시글 및 댓글</li>
                <li>승부예측 기록 및 포인트</li>
                <li>채팅 기록</li>
              </ul>
              <p className="text-sm text-red-400 font-medium">
                이 작업은 되돌릴 수 없습니다.
              </p>
            </div>

            <div className="mb-4">
              <label className="text-sm text-text-secondary block mb-2">
                확인을 위해 <strong>&quot;탈퇴&quot;</strong>를 입력해주세요
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfText(e.target.value)}
                placeholder="탈퇴"
                aria-label="탈퇴 확인 문구 입력"
                aria-required="true"
                className="w-full rounded-xl border border-white/10 bg-bg-tertiary px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-red-500/50"
              />
            </div>

            {error && (
              <p className="text-sm text-red-400 mb-3">{error}</p>
            )}

            <button
              onClick={handleDelete}
              disabled={!canDelete || isDeleting}
              className="w-full rounded-xl py-3.5 text-sm font-semibold transition-all disabled:opacity-30 disabled:cursor-not-allowed bg-red-600 text-white active:scale-[0.98]"
            >
              {isDeleting ? "삭제 중..." : "계정 영구 삭제"}
            </button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
