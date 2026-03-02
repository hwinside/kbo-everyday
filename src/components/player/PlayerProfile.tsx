"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, User, Trophy, Sparkles } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";

import { PLAYER_PROFILES } from '@/lib/constants/player-profiles';



interface Props {
  playerName: string;
  teamColor: string;
}

export default function PlayerProfile({ playerName, teamColor }: Props) {
  const profile = PLAYER_PROFILES[playerName];
  const [activeSection, setActiveSection] = useState<"bio" | "career" | "tmi">("bio");

  if (!profile) return null;

  const sections = [
    { id: "bio" as const, label: "소개", icon: User },
    { id: "career" as const, label: "커리어", icon: Trophy },
    { id: "tmi" as const, label: "TMI", icon: Sparkles },
  ];

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
          {activeSection === "bio" && profile.bio}
          {activeSection === "career" && profile.career}
          {activeSection === "tmi" && profile.tmi}
        </p>
      </div>


    </GlassCard>
  );
}
