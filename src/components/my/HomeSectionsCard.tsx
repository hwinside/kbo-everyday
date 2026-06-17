"use client";

import { useEffect, useState } from "react";
import { LayoutDashboard } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import {
  getAllSectionVisibility,
  HOME_SECTIONS,
  HOME_SECTIONS_PREF_EVENT,
  setSectionVisible,
  ALL_VISIBLE,
  type HomeSectionVisibility,
} from "@/lib/store/home-sections-pref";

// 홈 화면 섹션별 on/off (기기 로컬 설정). 숏츠 토글을 6개 섹션으로 일반화.
export default function HomeSectionsCard() {
  const [visibility, setVisibility] = useState<HomeSectionVisibility>(ALL_VISIBLE);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisibility(getAllSectionVisibility());
    const onChange = () => setVisibility(getAllSectionVisibility());
    window.addEventListener(HOME_SECTIONS_PREF_EVENT, onChange);
    return () => window.removeEventListener(HOME_SECTIONS_PREF_EVENT, onChange);
  }, []);

  return (
    <GlassCard className="p-5">
      <div className="flex items-center gap-4 mb-4">
        <LayoutDashboard size={22} className="text-text-secondary" />
        <div className="text-left">
          <span className="text-base text-text-primary">홈 화면 구성</span>
          <p className="text-xs text-text-tertiary mt-0.5">홈에 표시할 섹션을 켜고 끌 수 있어요</p>
        </div>
      </div>

      <div className="flex flex-col divide-y divide-border/40">
        {HOME_SECTIONS.map((section) => {
          const on = visibility[section.key];
          return (
            <div key={section.key} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
              <div className="text-left">
                <span className="text-[15px] text-text-primary">{section.label}</span>
                <p className="text-xs text-text-tertiary mt-0.5">{section.desc}</p>
              </div>
              <button
                onClick={() => setSectionVisible(section.key, !on)}
                className={`relative w-12 h-7 rounded-full transition-colors flex-shrink-0 ${on ? "bg-accent" : "bg-bg-tertiary"}`}
                aria-label={`${section.label} ${on ? "숨기기" : "표시"}`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-0"}`}
                />
              </button>
            </div>
          );
        })}
      </div>
    </GlassCard>
  );
}
