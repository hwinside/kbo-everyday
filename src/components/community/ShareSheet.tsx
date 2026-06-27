"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Share2, Instagram, Film, Link2, Check } from "lucide-react";
import { sharePost, getPostShareUrl } from "@/lib/utils/post-share";
import { shareToInstagram, canShareToInstagram, canShareReels, type InstaSharePost } from "@/lib/share/instagram";

export interface ShareSheetPost extends InstaSharePost {
  board_type?: string | null;
  board_id?: string | null;
}

interface ShareSheetProps {
  isOpen: boolean;
  onClose: () => void;
  post: ShareSheetPost | null;
}

export default function ShareSheet({ isOpen, onClose, post }: ShareSheetProps) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const igAvailable = canShareToInstagram();
  const reelsAvailable = post ? canShareReels(post) : false;

  async function handleLink() {
    if (!post) return;
    const result = await sharePost(post);
    if (result === "copied") {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      return;
    }
    if (result === "shared") onClose();
  }

  async function handleCopy() {
    if (!post) return;
    try {
      await navigator.clipboard.writeText(getPostShareUrl(post, window.location.origin));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      alert("링크 복사에 실패했어요");
    }
  }

  async function handleInstagram(mode: "story" | "reels") {
    if (!post || busy) return;
    setBusy(true);
    try {
      const result = await shareToInstagram(post, mode);
      if (result === "shared") onClose();
      else if (result === "unsupported") alert("이 기기에서는 인스타 공유를 지원하지 않아요. 링크 복사를 이용해주세요.");
      else if (result === "error") alert("공유 준비 중 문제가 생겼어요. 다시 시도해주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AnimatePresence>
      {isOpen && post && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[10000] bg-black/60"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed bottom-0 left-0 right-0 z-[10001] mx-auto max-w-lg rounded-t-3xl bg-bg-secondary p-5 pb-safe"
          >
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold text-text-primary">공유</h2>
              <button onClick={onClose} className="p-1 rounded-full hover:bg-bg-tertiary" aria-label="닫기">
                <X size={20} className="text-text-tertiary" />
              </button>
            </div>

            <div className="space-y-3">
              <SheetButton icon={<Share2 size={20} />} label="공유 / 카카오톡 · 메시지" onClick={handleLink} />

              {igAvailable && (
                <SheetButton
                  icon={<Instagram size={20} />}
                  label="인스타그램 스토리"
                  onClick={() => handleInstagram("story")}
                  disabled={busy}
                />
              )}

              {reelsAvailable && (
                <SheetButton
                  icon={<Film size={20} />}
                  label="인스타그램 릴스"
                  onClick={() => handleInstagram("reels")}
                  disabled={busy}
                />
              )}

              <SheetButton
                icon={copied ? <Check size={20} className="text-accent" /> : <Link2 size={20} />}
                label={copied ? "링크 복사됨" : "링크 복사"}
                onClick={handleCopy}
              />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function SheetButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-3 py-3.5 px-4 rounded-xl bg-bg-tertiary text-text-primary text-sm font-medium transition-transform active:scale-[0.98] disabled:opacity-50"
    >
      <span className="text-text-secondary">{icon}</span>
      {label}
    </button>
  );
}
