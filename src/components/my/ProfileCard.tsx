"use client";

import { ChevronRight, Settings } from "lucide-react";
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
  onNicknameClick: () => void;
  onViewProfile?: () => void;
}

export default function ProfileCard({ user, profile, team, onAvatarClick, onNicknameClick, onViewProfile }: ProfileCardProps) {
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
            <div className="absolute bottom-0 right-0 w-5 h-5 bg-bg-secondary rounded-full flex items-center justify-center border border-black/15 dark:border-white/20">
              <Settings size={10} className="text-text-secondary" />
            </div>
          )}
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            {user ? (
              <button onClick={onNicknameClick} className="flex items-center gap-1 rounded-full -ml-1 px-1 py-0.5 text-left hover:bg-bg-tertiary transition-colors">
                <span className="text-lg font-semibold text-text-primary">{profile?.nickname || user.email || "유저"}</span>
                <ChevronRight size={16} className="text-text-tertiary" />
              </button>
            ) : (
              <span className="text-lg font-semibold text-text-primary">게스트</span>
            )}
            {team && <TeamBadge teamId={team.id} />}
          </div>
          <LevelBadge level={15} showTitle />
          {user && <p className="mt-1 text-xs text-text-tertiary">닉네임을 누르면 변경할 수 있어요</p>}
          <p className="mt-0.5 text-base text-text-tertiary">{user ? `${profile?.points || 0} 포인트` : "로그인 해주세요"}</p>
        </div>
      </div>

      {user && onViewProfile && (
        <button
          onClick={onViewProfile}
          className="mt-4 flex w-full items-center justify-between rounded-2xl bg-bg-tertiary px-4 py-3 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5"
        >
          <span className="text-sm font-medium text-text-primary">내 프로필 보기</span>
          <ChevronRight size={18} className="text-text-tertiary" />
        </button>
      )}
    </GlassCard>
  );
}
