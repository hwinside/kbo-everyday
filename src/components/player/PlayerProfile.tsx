"use client";

import { useState } from "react";
import { User, Trophy, Sparkles } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { PLAYER_PROFILES } from '@/lib/constants/player-profiles';

interface Props {
  playerName: string;
  teamColor: string;
}

function renderText(text: string) {
  // 리터럴 \n을 실제 줄바꿈으로 변환
  return text.replace(/\\n/g, '\n');
}

export default function PlayerProfile({ playerName, teamColor }: Props) {
  const profile = PLAYER_PROFILES[playerName];
  const [activeSection, setActiveSection] = useState<"bio" | "career" | "tmi">("bio");

  if (!profile) return (
    <GlassCard className="p-4 mb-4">
      <div className="text-center py-4">
        <Sparkles size={24} className="mx-auto mb-2 text-text-tertiary" />
        <p className="text-sm font-medium text-text-primary mb-1">아직 프로필이 없어요</p>
        <p className="text-xs text-text-tertiary">이 선수의 팬이라면 게시판에 소개글을 남겨주세요!</p>
        <p className="text-xs text-text-tertiary mt-1">채택되면 공식 프로필로 등록됩니다 ✨</p>
      </div>
    </GlassCard>
  );

  const sections = [
    { id: "bio" as const, label: "소개", icon: User },
    { id: "career" as const, label: "커리어", icon: Trophy },
    { id: "tmi" as const, label: "TMI", icon: Sparkles },
  ];

  const content = activeSection === "bio" ? profile.bio
    : activeSection === "career" ? profile.career
    : profile.tmi;

  return (
    <GlassCard className="p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={16} style={{ color: teamColor }} />
        <h3 className="text-sm font-bold text-text-primary">선수 프로필</h3>
      </div>

      {/* Section tabs */}
      <div className="flex gap-1 mb-3 bg-bg-tertiary rounded-lg p-1">
        {sections.map(s => (
          <button
            key={s.id}
            onClick={() => setActiveSection(s.id)}
            className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md text-xs font-medium transition-all ${
              activeSection === s.id
                ? "bg-white/10 text-text-primary"
                : "text-text-tertiary"
            }`}
            style={activeSection === s.id ? { color: teamColor } : {}}
          >
            <s.icon size={12} />
            {s.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="bg-bg-tertiary rounded-xl p-4">
        <p className="text-sm text-text-secondary whitespace-pre-line leading-relaxed">
          {renderText(content)}
        </p>
      </div>

      {/* 출처 */}
      <p className="text-[10px] text-text-tertiary text-center mt-2">📌 출처: KBO 공식 · 나무위키 · Statiz</p>
    </GlassCard>
  );
}
