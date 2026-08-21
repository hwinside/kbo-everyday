"use client";

import { useState } from "react";
import { ChevronLeft, Trophy, Medal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getTeamById } from "@/lib/constants/teams";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";

interface LeaderEntry {
  rank: number;
  nickname: string;
  teamId: number;
  score: number;
  correct: number;
  total: number;
}

const MOCK_LEADERS: LeaderEntry[] = [
  { rank: 1, nickname: "야구는인생", teamId: 6, score: 850, correct: 6, total: 8 },
  { rank: 2, nickname: "잠실의신", teamId: 1, score: 720, correct: 5, total: 8 },
  { rank: 3, nickname: "사직러버", teamId: 7, score: 680, correct: 5, total: 8 },
  { rank: 4, nickname: "수원갈매기", teamId: 3, score: 620, correct: 4, total: 8 },
  { rank: 5, nickname: "대구독수리", teamId: 8, score: 580, correct: 4, total: 8 },
  { rank: 6, nickname: "인천바다", teamId: 4, score: 540, correct: 4, total: 8 },
  { rank: 7, nickname: "창원돌풍", teamId: 5, score: 500, correct: 3, total: 8 },
  { rank: 8, nickname: "광주호랑이", teamId: 6, score: 460, correct: 3, total: 8 },
  { rank: 9, nickname: "대전독수리", teamId: 9, score: 420, correct: 3, total: 8 },
  { rank: 10, nickname: "고척히어로", teamId: 10, score: 380, correct: 2, total: 8 },
];

const MEDAL_COLORS = ["text-amber-400", "text-gray-300", "text-amber-700"];

export default function LeaderboardPage() {
  const router = useRouter();
  const goBack = useSafeBack("/predict");
  const { profile } = useAuth();
  const myTeamBorder = profile?.team_id ? getTeamBorderColorById(profile.team_id) : undefined;

  return (
    <div className="min-h-screen bg-bg-primary pb-24">
      <div className="sticky top-0 z-30 border-b bg-bg-primary/80 backdrop-blur-xl" style={{ borderColor: myTeamBorder || 'var(--color-border)', paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
        <div className="flex items-center gap-3 px-5 min-h-[44px]">
          <button onClick={goBack} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors -ml-2.5">
            <ChevronLeft size={24} />
          </button>
          <span className="min-w-0 flex-1 truncate text-lg font-bold text-text-primary">🏆 예측 리더보드</span>
        </div>
      </div>

      <div className="px-5 py-4">
        <p className="text-sm text-text-tertiary mb-4">
          시즌 종료 후 예측 결과로 순위가 결정됩니다. 지금은 미리보기!
        </p>

        <div className="space-y-3">
          {MOCK_LEADERS.map((entry, i) => (
            <GlassCard key={entry.rank} className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-8 text-center">
                  {i < 3 ? (
                    <Trophy size={20} className={MEDAL_COLORS[i]} />
                  ) : (
                    <span className="text-sm font-bold text-text-tertiary">{entry.rank}</span>
                  )}
                </div>
                <div className="w-8 h-8 rounded-full bg-black/8 dark:bg-white/10 flex items-center justify-center text-sm font-bold text-text-primary">
                  {entry.nickname.charAt(0)}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-text-primary">{entry.nickname}</span>
                    <TeamBadge teamId={entry.teamId} size="xs" />
                  </div>
                  <span className="text-xs text-text-tertiary">{entry.correct}/{entry.total} 적중</span>
                </div>
                <span className="text-base font-black text-accent">{entry.score}P</span>
              </div>
            </GlassCard>
          ))}
        </div>

        <div className="mt-6 text-center text-xs text-text-tertiary space-y-1">
          <p>📌 우승팀 적중: +200P</p>
          <p>📌 MVP/신인왕 적중: +150P</p>
          <p>📌 타이틀 적중: +100P</p>
          <p>📌 꼴찌팀 적중: +50P</p>
        </div>
      </div>
    </div>
  );
}
