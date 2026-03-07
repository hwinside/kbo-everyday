"use client";

import { useState } from "react";
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
  const currentKey = getPresetKey(currentAvatarUrl);
  const team = teamId ? TEAMS.find(t => t.id === teamId) : null;

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    const avatarUrl = selected ? `preset:${selected}` : null;
    await supabase
      .from("profiles")
      .update({ avatar_url: avatarUrl })
      .eq("id", user.id);
    await refreshProfile();
    setSaving(false);
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-50 bg-black/60"
          />
          {/* Sheet */}
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed bottom-0 left-0 right-0 z-50 mx-auto max-w-lg rounded-t-3xl bg-bg-secondary border-t border-white/10 px-5 pb-10 pt-4"
          >
            {/* Handle */}
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-text-tertiary/30" />

            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-text-primary">아바타 선택</h2>
              <button onClick={onClose} className="rounded-full p-1 hover:bg-bg-tertiary transition-colors">
                <X size={22} className="text-text-secondary" />
              </button>
            </div>

            {/* 현재 미리보기 */}
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 rounded-full overflow-hidden bg-bg-tertiary flex items-center justify-center">
                {selected ? (
                  <img
                    src={PRESET_AVATARS.find(a => a.key === selected)?.path}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div
                    className="w-full h-full flex items-center justify-center text-3xl font-bold text-white"
                    style={{ backgroundColor: team?.colorPrimary ?? '#6366f1' }}
                  >
                    {nickname?.charAt(0) || '?'}
                  </div>
                )}
              </div>
            </div>

            {/* 기본(이니셜) 옵션 */}
            <button
              onClick={() => setSelected(null)}
              className={`w-full mb-4 p-3 rounded-2xl flex items-center gap-3 transition-colors ${
                selected === null ? 'bg-accent/10 border border-accent/30' : 'bg-bg-glass'
              }`}
            >
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold text-white"
                style={{ backgroundColor: team?.colorPrimary ?? '#6366f1' }}
              >
                {nickname?.charAt(0) || '?'}
              </div>
              <span className="text-sm font-medium text-text-primary">기본 (이니셜)</span>
              {selected === null && <Check size={18} className="ml-auto text-accent" />}
            </button>

            {/* 프리셋 그리드 */}
            <div className="grid grid-cols-4 gap-3 mb-6 max-h-[240px] overflow-y-auto">
              {PRESET_AVATARS.map((avatar) => (
                <button
                  key={avatar.key}
                  onClick={() => setSelected(avatar.key)}
                  className={`flex flex-col items-center gap-1 p-2 rounded-xl transition-colors ${
                    selected === avatar.key
                      ? 'bg-accent/10 ring-2 ring-accent'
                      : 'hover:bg-bg-tertiary'
                  }`}
                >
                  <div className="w-14 h-14 rounded-full overflow-hidden bg-white">
                    <img src={avatar.path} alt={avatar.label} className="w-full h-full object-cover" />
                  </div>
                  <span className="text-[11px] text-text-tertiary">{avatar.label}</span>
                </button>
              ))}
            </div>

            {/* 저장 버튼 */}
            <button
              onClick={handleSave}
              disabled={saving || selected === currentKey}
              className={`w-full py-3 rounded-2xl text-base font-semibold transition-colors ${
                saving || selected === currentKey
                  ? 'bg-bg-tertiary text-text-tertiary'
                  : 'bg-accent text-white'
              }`}
            >
              {saving ? '저장 중...' : '저장'}
            </button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
