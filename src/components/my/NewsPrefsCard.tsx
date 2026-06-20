"use client";

import { Images } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { setPhotoFilterEnabled } from "@/lib/store/news-pref";
import { useNewsPhotoFilter } from "@/hooks/useNewsPhotoFilter";

// 뉴스 설정 카드 — 사진기사(포토·화보) 숨김 토글. 기기 로컬(localStorage).
export default function NewsPrefsCard() {
  const on = useNewsPhotoFilter();

  const toggle = () => setPhotoFilterEnabled(!on);

  return (
    <GlassCard className="p-5">
      <p className="text-sm font-medium text-text-secondary mb-3">뉴스 설정</p>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-bg-tertiary">
            <Images size={18} className="text-text-secondary" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">사진기사 숨기기</p>
            <p className="text-xs text-text-tertiary mt-0.5 leading-relaxed">
              포토·화보 위주 기사를 홈·팀 뉴스에서 숨깁니다
            </p>
          </div>
        </div>
        <button
          onClick={toggle}
          className={`relative w-12 h-7 rounded-full transition-colors flex-shrink-0 ${on ? "bg-accent" : "bg-bg-tertiary"}`}
          aria-label={`사진기사 ${on ? "표시" : "숨기기"}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-0"}`}
          />
        </button>
      </div>
    </GlassCard>
  );
}
