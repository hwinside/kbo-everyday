"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";

import { useAuth } from "@/lib/supabase/AuthContext";
import { getExistingConversation } from "@/lib/supabase/useDM";
import {
  BASEBALL_GENIUS_NAME,
  BASEBALL_GENIUS_SCOPE_NOTICE,
  BASEBALL_GENIUS_USER_ID,
} from "@/lib/constants/baseball-genius";

const STORAGE_KEY_PREFIX = "genius_launch_seen_v1_";

export default function GeniusLaunchPopup({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!enabled || loading || !user) return;
    try {
      if (localStorage.getItem(`${STORAGE_KEY_PREFIX}${user.id}`) !== "1") {
        setOpen(true);
      }
    } catch {
      setOpen(true);
    }
  }, [enabled, loading, user]);

  const dismiss = () => {
    if (user) {
      try {
        localStorage.setItem(`${STORAGE_KEY_PREFIX}${user.id}`, "1");
      } catch {
        // private mode 등 저장 실패는 닫기 동작을 막지 않는다.
      }
    }
    setOpen(false);
  };

  const enterConversation = async () => {
    if (!user || pending) return;
    setPending(true);
    try {
      const conversationId = await getExistingConversation(user.id, BASEBALL_GENIUS_USER_ID);
      dismiss();
      router.push(
        conversationId
          ? `/messages/${conversationId}`
          : `/messages/new-${BASEBALL_GENIUS_USER_ID}`,
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          data-testid="genius-launch-popup"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 px-5"
          role="dialog"
          aria-modal="true"
          aria-labelledby="genius-launch-title"
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-border bg-bg-secondary p-6 text-center shadow-2xl"
          >
            <button
              type="button"
              onClick={dismiss}
              aria-label="닫기"
              className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-full text-text-tertiary hover:bg-bg-tertiary"
            >
              <X size={20} />
            </button>

            {/* eslint-disable-next-line @next/next/no-img-element -- 기존 야잘알봇 마스코트 정적 자산 재사용 */}
            <img
              src="/mascot/yajalal-avatar.png"
              alt=""
              aria-hidden
              className="mx-auto h-40 w-auto max-w-none object-contain"
            />
            <h2 id="genius-launch-title" className="mt-2 text-xl font-bold text-text-primary">
              야잘알봇이 더 똑똑해졌어요
            </h2>
            <p className="mt-3 break-keep text-sm leading-6 text-text-secondary">
              {BASEBALL_GENIUS_SCOPE_NOTICE}
              <br />
              궁금한 걸 편하게 물어보세요.
            </p>
            <button
              type="button"
              onClick={enterConversation}
              disabled={pending}
              className="mt-6 flex h-12 w-full items-center justify-center rounded-2xl bg-accent text-sm font-bold text-white transition-opacity disabled:opacity-50"
            >
              {BASEBALL_GENIUS_NAME}에게 물어보기
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
