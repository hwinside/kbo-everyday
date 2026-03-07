"use client";

import { useState, useEffect, useRef, useCallback } from "react";
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

export default function AvatarSelectSheet({ isOpen, onClose, currentAvatarUrl, teamId, nickname }: Props) {
  const { user, refreshProfile } = useAuth();
  const [selected, setSelected] = useState<string | null>(getPresetKey(currentAvatarUrl));
  const [saving, setSaving] = useState(false);
  const team = teamId ? TEAMS.find(t => t.id === teamId) : null;
  const scrollRef = useRef<HTMLDivElement>(null);

  // iOS Safari: 배경 스크롤 방지 + 시트 내부 스크롤 허용
  useEffect(() => {
    if (!isOpen) return;

    const scrollEl = scrollRef.current;

    // 배경 터치 스크롤 차단 (시트 내부 스크롤 영역은 허용)
    function preventBgScroll(e: TouchEvent) {
      if (scrollEl && scrollEl.contains(e.target as Node)) {
        // 스크롤 영역 내부: 스크롤 가능하면 허용, 끝에서는 방지
        const { scrollTop, scrollHeight, clientHeight } = scrollEl;
        const atTop = scrollTop <= 0;
        const atBottom = scrollTop + clientHeight >= scrollHeight;
        const touchY = e.touches[0]?.clientY;

        if (!touchY) return;

        // 스크롤할 콘텐츠가 있으면 허용
        if (scrollHeight > clientHeight) {
          // 맨 위에서 위로 당기거나, 맨 아래에서 아래로 당기는 경우만 방지
          if (atTop && atBottom) {
            e.preventDefault();
          }
          return; // 나머지는 정상 스크롤 허용
        }
        e.preventDefault();
      } else {
        // 스크롤 영역 밖 (backdrop, header 등): 배경 스크롤 방지
        e.preventDefault();
      }
    }

    document.addEventListener("touchmove", preventBgScroll, { passive: false });
    return () => {
      document.removeEventListener("touchmove", preventBgScroll);
    };
  }, [isOpen]);

  const handleSelect = async (key: string | null) => {
    if (!user || saving) return;
    setSelected(key);
    setSaving(true);
    const avatarUrl = key ? `preset:${key}` : null;
    await supabase
      .from("profiles")
      .update({ avatar_url: avatarUrl })
      .eq("id", user.id);
    await refreshProfile();
    setSaving(false);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-50 bg-black/60"
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed bottom-0 left-0 right-0 z-50 mx-auto max-w-lg rounded-t-3xl bg-bg-secondary border-t border-white/10 flex flex-col"
            style={{ maxHeight: "70vh" }}
          >
            {/* Handle */}
            <div className="mx-auto mt-3 mb-2 h-1 w-10 rounded-full bg-text-tertiary/30 flex-shrink-0" />

            {/* Header */}
            <div className="flex items-center justify-between px-5 mb-3 flex-shrink-0">
              <h2 className="text-lg font-bold text-text-primary">아바타 선택</h2>
              <button onClick={onClose} className="rounded-full p-1 hover:bg-bg-tertiary transition-colors">
                <X size={22} className="text-text-secondary" />
              </button>
            </div>

            {/* 스크롤 영역 */}
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto px-5 pb-8"
              style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}
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
                    className={`flex flex-col items-center gap-1.5 p-2 rounded-xl transition-all ${
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
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
