"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarDays, ChevronDown, MapPin, RefreshCw, Trophy } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { getTeamById } from "@/lib/constants/teams";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getSafeSession } from "@/lib/supabase/client";
import type {
  VenueAttendanceSummary,
  VenueDiaryItem,
} from "@/lib/venue-attendance/summary";
import type {
  FavoritePlayerPerformance,
  PlayerPerformanceLine,
} from "@/lib/venue-attendance/player-comparison";

interface VenueDiaryResponse {
  season: number;
  summary: VenueAttendanceSummary;
  games: Array<VenueDiaryItem & { favoritePlayers: FavoritePlayerPerformance[] }>;
}

function formatGameDate(date: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(`${date}T12:00:00+09:00`));
}

function teamLabel(team: { id: number; name: string } | null): string {
  if (!team) return "경기 정보 확인 중";
  return getTeamById(team.id)?.shortName ?? team.name;
}

function statusLabel(item: VenueDiaryItem): string {
  if (item.status === "scheduled") return "예정";
  if (item.status === "live") return "진행 중";
  if (item.status === "cancelled") return "취소";
  if (item.status === "unavailable") return "결과 확인 중";
  if (item.awayTeam?.score == null || item.homeTeam?.score == null) return "종료";
  return `${item.awayTeam.score} : ${item.homeTeam.score}`;
}

const RESULT_STYLE = {
  W: "bg-blue-500/15 text-blue-500",
  L: "bg-red-500/15 text-red-500",
  D: "bg-gray-500/15 text-text-secondary",
} as const;

const EVALUATION_LABEL = {
  above: { text: "평균 이상", className: "bg-blue-500/15 text-blue-500" },
  similar: { text: "평균 비슷", className: "bg-gray-500/15 text-text-secondary" },
  below: { text: "아쉬움", className: "bg-orange-500/15 text-orange-500" },
} as const;

function innings(outs: number | undefined): string {
  const value = outs ?? 0;
  return `${Math.floor(value / 3)}${value % 3 ? `.${value % 3}` : ""}`;
}

function performanceText(line: PlayerPerformanceLine): string {
  const stats = line.today;
  if (line.type === "batter") {
    return `${stats.ab ?? 0}타수 ${stats.h ?? 0}안타 ${stats.hr ?? 0}홈런 ${stats.rbi ?? 0}타점`;
  }
  return `${innings(stats.ipOuts)}이닝 ${stats.er ?? 0}자책 ${stats.strikeouts ?? 0}K`;
}

function averagePerformanceText(line: PlayerPerformanceLine): string | null {
  if (!line.average) return null;
  if (line.type === "batter") {
    return `${line.average.ab?.toFixed(1)}타수 ${line.average.h?.toFixed(1)}안타 ${line.average.hr?.toFixed(1)}홈런 ${line.average.rbi?.toFixed(1)}타점`;
  }
  return `${line.average.innings?.toFixed(1)}이닝 ${line.average.er?.toFixed(1)}자책 ${line.average.strikeouts?.toFixed(1)}K`;
}

export default function VenueDiaryCard() {
  const { user } = useAuth();
  const [loaded, setLoaded] = useState<{ userId: string; data: VenueDiaryResponse } | null>(null);
  const [loadingFor, setLoadingFor] = useState<string | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [expandedGameId, setExpandedGameId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    const requestedUserId = user.id;
    setLoadingFor(requestedUserId);
    setFailedFor(null);
    try {
      const session = await getSafeSession();
      if (!session?.access_token) throw new Error("missing session");
      const response = await fetch("/api/me/venue-attendance", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("request failed");
      setLoaded({ userId: requestedUserId, data: await response.json() });
    } catch {
      setFailedFor(requestedUserId);
    } finally {
      setLoadingFor((current) => current === requestedUserId ? null : current);
    }
  }, [user]);

  useEffect(() => {
    if (user) void load();
  }, [load, user]);

  if (!user) return null;

  const data = loaded?.userId === user.id ? loaded.data : null;
  const loading = loadingFor === user.id;
  const failed = failedFor === user.id;

  const visibleGames = showAll ? data?.games ?? [] : data?.games.slice(0, 5) ?? [];
  const hiddenCount = Math.max(0, (data?.games.length ?? 0) - 5);

  return (
    <GlassCard className="mt-3 p-0 overflow-hidden">
      <div className="p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarDays size={19} className="text-accent" />
            <h2 className="text-base font-semibold text-text-primary">직관 다이어리</h2>
          </div>
          <span className="text-xs text-text-tertiary">{data?.season ?? "올 시즌"}</span>
        </div>

        {loading && !data ? (
          <div className="mt-5 grid grid-cols-2 gap-3 animate-pulse">
            <div className="h-20 rounded-2xl bg-bg-tertiary" />
            <div className="h-20 rounded-2xl bg-bg-tertiary" />
          </div>
        ) : failed && !data ? (
          <button
            type="button"
            onClick={() => void load()}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-bg-tertiary py-4 text-sm text-text-secondary"
          >
            <RefreshCw size={15} /> 기록을 불러오지 못했어요 · 다시 시도
          </button>
        ) : data ? (
          <>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-bg-tertiary p-4">
                <p className="text-xs text-text-tertiary">{data.season} 시즌 직관</p>
                <p className="mt-1 text-2xl font-bold text-text-primary">
                  {data.summary.attendanceCount}<span className="ml-1 text-sm font-medium">경기</span>
                </p>
              </div>
              <div className="rounded-2xl bg-bg-tertiary p-4">
                <p className="text-xs text-text-tertiary">직관 승률</p>
                <p className="mt-1 text-2xl font-bold text-accent">
                  {data.summary.winRate == null
                    ? "–"
                    : `${(data.summary.winRate * 100).toFixed(1)}%`}
                </p>
                <p className="mt-0.5 text-[11px] text-text-tertiary">종료 경기 기준</p>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-3 divide-x divide-border rounded-2xl border border-border py-3 text-center">
              <div><span className="text-sm font-bold text-blue-500">{data.summary.wins}</span><span className="ml-1 text-xs text-text-tertiary">승</span></div>
              <div><span className="text-sm font-bold text-red-500">{data.summary.losses}</span><span className="ml-1 text-xs text-text-tertiary">패</span></div>
              <div><span className="text-sm font-bold text-text-secondary">{data.summary.draws}</span><span className="ml-1 text-xs text-text-tertiary">무</span></div>
            </div>
          </>
        ) : null}
      </div>

      {data && data.games.length === 0 && (
        <div className="border-t border-border px-5 py-6 text-center">
          <Trophy size={24} className="mx-auto text-text-tertiary" />
          <p className="mt-2 text-sm font-medium text-text-secondary">아직 직관 기록이 없어요</p>
          <p className="mt-1 text-xs text-text-tertiary">구장에서 직관 스토리를 올리면 자동으로 기록돼요</p>
        </div>
      )}

      {visibleGames.length > 0 && (
        <div className="border-t border-border">
          {visibleGames.map((item) => {
            const expanded = expandedGameId === item.gameId;
            const hasPlayers = item.favoritePlayers.length > 0;
            return (
              <div key={item.id} className="border-b border-border last:border-b-0">
                <button
                  type="button"
                  onClick={() => hasPlayers && setExpandedGameId(expanded ? null : item.gameId)}
                  className="flex w-full items-center gap-3 px-5 py-4 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-tertiary">{formatGameDate(item.date)}</span>
                      {item.result && (
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${RESULT_STYLE[item.result]}`}>
                          {item.result === "W" ? "승" : item.result === "L" ? "패" : "무"}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-sm font-semibold text-text-primary">
                      {teamLabel(item.awayTeam)} <span className="mx-1 text-text-tertiary">vs</span> {teamLabel(item.homeTeam)}
                    </p>
                    <p className="mt-1 flex items-center gap-1 truncate text-xs text-text-tertiary">
                      <MapPin size={12} /> {item.stadium ?? "구장 확인 중"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="text-sm font-semibold text-text-secondary">{statusLabel(item)}</span>
                    {hasPlayers && <ChevronDown size={15} className={expanded ? "rotate-180" : ""} />}
                  </div>
                </button>

                {expanded && hasPlayers && (
                  <div className="mx-5 mb-4 rounded-2xl bg-bg-tertiary p-4">
                    <p className="text-xs font-semibold text-text-primary">내 최애선수 오늘 활약</p>
                    <div className="mt-3 space-y-3">
                      {item.favoritePlayers.map((player) => (
                        <div key={player.playerId} className="border-t border-border/50 pt-3 first:border-0 first:pt-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold text-text-primary">{player.name}</span>
                            {player.state === "pending" && <span className="text-[11px] text-text-tertiary">기록 집계 중</span>}
                            {player.state === "not_played" && <span className="text-[11px] text-text-tertiary">오늘 출전 없음</span>}
                          </div>
                          {player.lines.map((line) => (
                            <div key={line.type} className="mt-2">
                              <div className="flex items-center gap-2">
                                <span className="text-[11px] font-medium text-text-tertiary">{line.type === "batter" ? "타자" : "투수"}</span>
                                {line.evaluation && (
                                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${EVALUATION_LABEL[line.evaluation].className}`}>
                                    {EVALUATION_LABEL[line.evaluation].text}
                                  </span>
                                )}
                                {line.state === "sample_limited" && (
                                  <span className="text-[10px] text-text-tertiary">비교 표본 부족</span>
                                )}
                              </div>
                              <p className="mt-1 text-xs text-text-secondary">오늘 · {performanceText(line)}</p>
                              {averagePerformanceText(line) && (
                                <p className="mt-0.5 text-[11px] text-text-tertiary">
                                  경기 전 평균 · {averagePerformanceText(line)}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              className="flex w-full items-center justify-center gap-1 border-t border-border py-3 text-xs font-medium text-text-secondary"
            >
              {showAll ? "접기" : `${hiddenCount}경기 더 보기`}
              <ChevronDown size={14} className={showAll ? "rotate-180" : ""} />
            </button>
          )}
        </div>
      )}
    </GlassCard>
  );
}
