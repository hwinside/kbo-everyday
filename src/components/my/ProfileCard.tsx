"use client";

import { ChevronRight, Settings, Trophy } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import LevelBadge from "@/components/ui/LevelBadge";
import { getNextLevel } from "@/lib/constants/levels";
import { getTeamBgColor } from "@/lib/constants/teams";
import { getAvatarPath } from "@/lib/constants/avatars";
import type { User } from "@supabase/supabase-js";
import type { TeamData } from "@/lib/constants/teams";

interface ProfileCardProps {
  user: User | null;
  profile: { nickname?: string; avatar_url?: string | null } | null;
  team: TeamData | null;
  // 누적 점수(SSOT = v_leaderboard_writing, my-rank API). profile.points 비의존(드리프트 방지).
  // number = 확정 점수(집계 0건이면 0), null/undefined = 로딩·확인 중(0으로 확정 표시 금지).
  points?: number | null;
  onAvatarClick: () => void;
  onNicknameClick: () => void;
  onViewProfile?: () => void;
  onHallOfFame?: () => void;
}

export default function ProfileCard({ user, profile, team, points, onAvatarClick, onNicknameClick, onViewProfile, onHallOfFame }: ProfileCardProps) {
  // 점수 확정 전(로딩/토큰없음/실패)에는 0으로 떨어뜨리지 않고 보류 표시.
  const isScoreLoading = !!user && typeof points !== "number";
  const score = user && typeof points === "number" ? points : null;
  const nextLevel = score !== null ? getNextLevel(score) : null;
  const remaining = nextLevel ? Math.max(0, nextLevel.requiredPoints - (score ?? 0)) : 0;
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
          {user ? (
            <>
              {isScoreLoading ? (
                <p className="text-sm text-text-tertiary">점수 확인 중…</p>
              ) : (
                <div className="flex items-center gap-2">
                  <LevelBadge points={score ?? 0} showTitle />
                  <span className="text-xs text-text-tertiary">
                    {nextLevel ? `· 다음 레벨까지 ${remaining}점` : "· 최고 레벨 달성 🎉"}
                  </span>
                </div>
              )}
              <p className="mt-1 text-xs text-text-tertiary">닉네임을 누르면 변경할 수 있어요</p>
              {!isScoreLoading && <p className="mt-0.5 text-base text-text-tertiary">{score ?? 0} 포인트</p>}
            </>
          ) : (
            <p className="mt-0.5 text-base text-text-tertiary">로그인 해주세요</p>
          )}
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

      {user && onHallOfFame && (
        <button
          onClick={onHallOfFame}
          className="mt-2 flex w-full items-center justify-between rounded-2xl bg-bg-tertiary px-4 py-3 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <Trophy size={16} className="text-yellow-500" />
            명예의 전당
          </span>
          <ChevronRight size={18} className="text-text-tertiary" />
        </button>
      )}
    </GlassCard>
  );
}
