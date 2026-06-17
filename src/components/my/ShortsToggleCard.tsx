"use client";

import { useEffect, useState } from "react";
import { Clapperboard } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { getShortsVisible, setShortsVisible, SHORTS_PREF_EVENT } from "@/lib/store/shorts-pref";

// 홈 숏츠 섹션 표시 on/off (기기 로컬 설정). 알림 설정 카드와 동일한 스위치 UI.
export default function ShortsToggleCard() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible(getShortsVisible());
    const onChange = () => setVisible(getShortsVisible());
    window.addEventListener(SHORTS_PREF_EVENT, onChange);
    return () => window.removeEventListener(SHORTS_PREF_EVENT, onChange);
  }, []);

  const toggle = () => {
    const next = !visible;
    setVisible(next);
    setShortsVisible(next);
  };

  return (
    <GlassCard className="p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Clapperboard size={22} className="text-text-secondary" />
          <div className="text-left">
            <span className="text-base text-text-primary">숏츠 표시</span>
            <p className="text-xs text-text-tertiary mt-0.5">홈 화면에 숏츠 영상 섹션을 보여줍니다</p>
          </div>
        </div>
        <button
          onClick={toggle}
          className={`relative w-12 h-7 rounded-full transition-colors flex-shrink-0 ${visible ? "bg-accent" : "bg-bg-tertiary"}`}
          aria-label={`숏츠 ${visible ? "숨기기" : "표시"}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${visible ? "translate-x-5" : "translate-x-0"}`}
          />
        </button>
      </div>
    </GlassCard>
  );
}
