"use client";

import { useMemo } from "react";
import { TEAMS, getTeamBgColor, getTeamById } from "@/lib/constants/teams";
import { useAuth } from "@/lib/supabase/AuthContext";

interface TeamTaggerProps {
  /** 선택된 팀 슬러그 배열 (복수). team_tags 와 동일 포맷. */
  selectedSlugs: string[];
  onToggle: (slug: string) => void;
}

/**
 * 팀 태그 다중 선택 칩.
 * - 모든 구단을 토글 칩으로 노출, 복수 선택 가능.
 * - 최애팀(profile.team_id)이 있으면 맨 앞으로 정렬. 기본 선택은 부모가 selectedSlugs로 주입.
 * - 선택 0개 + 선수태그 0개 = 자유글 (V3 태그 모델).
 */
export default function TeamTagger({ selectedSlugs, onToggle }: TeamTaggerProps) {
  const { profile } = useAuth();
  const favoriteTeamId = (profile as Record<string, unknown> | null)?.team_id as number | undefined;

  // 최애팀을 맨 앞으로 (없으면 기본 순서).
  const orderedTeams = useMemo(() => {
    const fav = favoriteTeamId ? getTeamById(favoriteTeamId) : undefined;
    if (!fav) return TEAMS;
    return [fav, ...TEAMS.filter((t) => t.id !== fav.id)];
  }, [favoriteTeamId]);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-text-secondary">팀 태그</p>
      <div className="flex flex-wrap gap-1.5">
        {orderedTeams.map((team) => {
          const selected = selectedSlugs.includes(team.slug);
          return (
            <button
              key={team.slug}
              type="button"
              onClick={() => onToggle(team.slug)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                selected ? "" : "bg-bg-tertiary text-text-secondary"
              }`}
              style={
                selected
                  ? { backgroundColor: getTeamBgColor(team), color: "#fff" }
                  : undefined
              }
              data-selected={selected}
            >
              {team.shortName}
            </button>
          );
        })}
      </div>
    </div>
  );
}
