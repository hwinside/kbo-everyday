"use client";

import { Settings } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import LevelBadge from "@/components/ui/LevelBadge";
import { getTeamBgColor } from "@/lib/constants/teams";
import { getAvatarPath } from "@/lib/constants/avatars";
import type { User } from "@supabase/supabase-js";
import type { TeamData } from "@/lib/constants/teams";

interface ProfileCardProps {
  user: User | null;
  profile: { nickname?: string; avatar_url?: string | null; points?: number } | null;
  team: TeamData | null;
  onAvatarClick: () => void;
}

export default function ProfileCard({ user, profile, team, onAvatarClick }: ProfileCardProps) {
  return (
    <GlassCard className="p-5">
      <div className="flex items-center gap-4">
        <button
          onClick={onAvatarClick}
          className="relative flex h-14 w-14 items-center justify-center rounded-full bg-bg-tertiary text-2xl overflow-hidden transition-transform hover:scale-105"
        >
          {profile?.avatar_url && getAvatarPath(profile.avatar_url) ? (
            <img src={getAvatarPath(profile.avatar_url)!} alt="" className="w-full h-full object-cover" />
          ) : profile?.nickname ? (
            <div
              className="w-full h-full flex items-center justify-center text-xl font-bold text-white"
              style={{ backgroundColor: team ? getTeamBgColor(team) : '#6366f1' }}
            >
              {profile.nickname.charAt(0)}
            </div>
          ) : (
            <>⚾</>
          )}
          {user && (
            <div className="absolute bottom-0 right-0 w-5 h-5 bg-bg-secondary rounded-full flex items-center justify-center border border-white/20">
              <Settings size={10} className="text-text-secondary" />
            </div>
          )}
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <span className="text-lg font-semibold text-text-primary">{user ? (profile?.nickname || user.email || "유저") : "게스트"}</span>
            {team && <TeamBadge teamId={team.id} />}
          </div>
          <LevelBadge level={15} showTitle />
          <p className="mt-0.5 text-base text-text-tertiary">{user ? `${profile?.points || 0} 포인트` : "로그인 해주세요"}</p>
        </div>
      </div>
    </GlassCard>
  );
}
