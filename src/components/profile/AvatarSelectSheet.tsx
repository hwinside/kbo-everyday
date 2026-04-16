"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Check } from "lucide-react";
import { PRESET_AVATARS, getPresetKey } from "@/lib/constants/avatars";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/supabase/AuthContext";
import { TEAMS } from "@/lib/constants/teams";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentAvatarUrl: string | null;
  teamId: number | null;
  nickname: string;
}

/**
 * iOS Safari body-scroll-lock:
 * body를 position:fixed로 고정 → 배경 스크롤 완전 차단
 * 시트는 이미 position:fixed이므로 내부 스크롤에 영향 없음
 */
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

export default function AvatarSelectSheet({ isOpen, onClose, currentAvatarUrl, teamId, nickname }: Props) {
  const { user, refreshProfile } = useAuth();
  const [selected, setSelected] = useState<string | null>(getPresetKey(currentAvatarUrl));
  const [saving, setSaving] = useState(false);
  const team = teamId ? TEAMS.find(t => t.id === teamId) : null;
  const scrollRef = useRef<HTMLDivElement>(null);

  useBodyScrollLock(isOpen);

  useEffect(() => {
    if (!isOpen) return;
    setSelected(getPresetKey(currentAvatarUrl));
  }, [isOpen, currentAvatarUrl]);

  // ESC 닫기
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

  const handleSelect = (key: string | null) => {
    if (!user || saving) return;
    setSelected(key);
  };

  const handleConfirm = async () => {
    if (!user || saving) return;
    setSaving(true);
    const avatarUrl = selected ? `preset:${selected}` : null;
    const { error } = await supabase
      .from("profiles")
      .update({ avatar_url: avatarUrl })
      .eq("id", user.id);
    if (error) {
      console.error("아바타 저장 실패:", error);
      setSaving(false);
      return;
    }
    await refreshProfile();
    setSaving(false);
    onClose();
  };

  if (typeof window === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-[60] bg-black/60"
          />

          {/* Sheet */}
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed bottom-0 left-0 right-0 z-[60] mx-auto max-w-lg rounded-t-3xl bg-bg-secondary border-t border-black/10 dark:border-white/10"
            style={{ maxHeight: "80dvh" }}
          >
            {/* Handle */}
            <div className="mx-auto mt-3 mb-2 h-1 w-10 rounded-full bg-text-tertiary/30" />

            {/* Header */}
            <div className="flex items-center justify-between px-5 mb-3">
              <h2 className="text-lg font-bold text-text-primary">아바타 선택</h2>
              <button onClick={onClose} className="rounded-full p-1 hover:bg-bg-tertiary transition-colors">
                <X size={22} className="text-text-secondary" />
              </button>
            </div>

            {/* 스크롤 영역 */}
            <div
              ref={scrollRef}
              className="overflow-y-auto px-5"
              style={{
                maxHeight: "calc(80dvh - 148px)",
                overscrollBehavior: "contain",
                paddingBottom: "16px",
              }}
            >
              {/* 기본(이니셜) 옵션 */}
              <button
                onClick={() => handleSelect(null)}
                className={`w-full mb-4 p-3 rounded-2xl flex items-center gap-3 transition-colors ${
                  selected === null ? 'bg-accent/10 border border-accent/30' : 'bg-bg-glass'
                }`}
              >
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold text-white flex-shrink-0"
                  style={{ backgroundColor: team?.colorPrimary ?? '#6366f1' }}
                >
                  {nickname?.charAt(0) || '?'}
                </div>
                <span className="text-sm font-medium text-text-primary">기본 (이니셜)</span>
                {selected === null && <Check size={18} className="ml-auto text-accent" />}
              </button>

              {/* 프리셋 그리드 */}
              <div className="grid grid-cols-4 gap-3">
                {PRESET_AVATARS.map((avatar) => (
                  <button
                    key={avatar.key}
                    onClick={() => handleSelect(avatar.key)}
                    className={`relative flex flex-col items-center gap-1.5 p-2 rounded-xl transition-all ${
                      selected === avatar.key
                        ? 'bg-accent/10 ring-2 ring-accent scale-105'
                        : 'hover:bg-bg-tertiary active:scale-95'
                    }`}
                  >
                    <div className={`w-14 h-14 rounded-full overflow-hidden flex items-center justify-center p-1.5 ${
                      selected === avatar.key ? 'bg-accent/20' : 'bg-bg-tertiary'
                    }`}>
                      <img src={avatar.path} alt={avatar.label} className="w-full h-full" />
                    </div>
                    <span className="text-[11px] text-text-tertiary">{avatar.label}</span>
                    {selected === avatar.key && (
                      <div className="absolute -top-0.5 -right-0.5">
                        <Check size={14} className="text-accent" />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-black/10 dark:border-white/10 px-5 pt-3 pb-[calc(16px+env(safe-area-inset-bottom,0px))]">
              <button
                onClick={handleConfirm}
                disabled={saving}
                className="w-full rounded-2xl bg-accent py-3 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
              >
                {saving ? "저장 중..." : "선택 완료"}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
