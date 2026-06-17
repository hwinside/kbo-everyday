"use client";

import { useEffect, useState } from "react";
import { Video } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { updateProfile } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

interface ShortsToggleCardProps {
  user: User | null;
  enabled: boolean;
  onSaved: () => Promise<void>;
}

export default function ShortsToggleCard({ user, enabled, onSaved }: ShortsToggleCardProps) {
  const [checked, setChecked] = useState(enabled);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setChecked(enabled);
  }, [enabled]);

  const toggle = async () => {
    if (!user || saving) return;

    const next = !checked;
    setChecked(next);
    setSaving(true);

    const { error } = await updateProfile(user.id, { show_shorts: next });
    if (error) {
      setChecked(!next);
      setSaving(false);
      return;
    }

    try {
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  if (!user) return null;

  return (
    <GlassCard className="p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <Video size={22} className="shrink-0 text-text-secondary" />
          <div className="min-w-0">
            <p className="text-base text-text-primary">숏츠 보기</p>
            <p className="text-xs leading-[18px] text-text-tertiary mt-0.5">
              홈의 내 팀·최애선수 숏츠 섹션을 켜고 끄세요
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={toggle}
          disabled={saving}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
            checked ? "bg-accent" : "bg-bg-tertiary"
          }`}
          aria-label={`숏츠 보기 ${checked ? "끄기" : "켜기"}`}
          aria-pressed={checked}
        >
          <span className={`absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-0"
          }`} />
        </button>
      </div>
    </GlassCard>
  );
}
