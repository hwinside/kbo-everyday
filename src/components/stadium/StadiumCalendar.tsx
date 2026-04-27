"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { getTeamById } from "@/lib/constants/teams";
import type { Stadium } from "@/lib/constants/stadiums";
import GlassCard from "@/components/ui/GlassCard";

interface StadiumGame {
  gameId: string;
  date: string; // YYYYMMDD
  time: string;
  homeTeamId: number;
  awayTeamId: number;
  homeName: string;
  awayName: string;
  status: "scheduled" | "live" | "final" | "cancelled";
}

interface StadiumCalendarProps {
  stadium: Stadium;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** 구단별 예매 오픈 정보 */
const TICKET_OPEN_INFO: Record<number, string> = {
  1: "경기 7일 전 오전 11시 (최대 4매)",   // LG
  2: "경기 7일 전 오전 11시 (최대 4매)",   // 두산
  3: "경기 7일 전 오후 4시 (최대 8매)",    // KT
  4: "경기 5일 전 오전 11시 (최대 6매)",   // SSG
  5: "경기 6일 전 오전 11시 (최대 10매)",  // NC
  6: "경기 7일 전 오전 11시 (최대 4매)",   // KIA
  7: "경기 14일 전 오후 2시 (최대 8매)",   // 롯데
  8: "경기 7일 전 오전 11시 (최대 6매)",   // 삼성
  9: "경기 7일 전 오전 11시 (최대 4매)",   // 한화
  10: "경기 7일 전 오후 2시 (최대 4매)",   // 키움
};

function getMonthKey(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export default function StadiumCalendar({ stadium }: StadiumCalendarProps) {
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [games, setGames] = useState<StadiumGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const monthKey = getMonthKey(currentDate);
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const fetchMonthGames = useCallback(async (mk: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/stadiums/${stadium.id}/games?month=${mk}`);
      if (res.ok) {
        const data = await res.json();
        setGames(data.games || []);
      }
    } catch {
      // silent
    }
    setLoading(false);
  }, [stadium.id]);

  useEffect(() => {
    fetchMonthGames(monthKey);
  }, [monthKey, fetchMonthGames]);

  // 날짜별 경기 맵
  const gamesByDate = new Map<string, StadiumGame[]>();
  for (const game of games) {
    const existing = gamesByDate.get(game.date) || [];
    existing.push(game);
    gamesByDate.set(game.date, existing);
  }

  // 달력 그리드 생성
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const today = new Date();
  const todayStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;

  function prevMonth() {
    setCurrentDate(new Date(year, month - 1, 1));
    setSelectedDate(null);
  }

  function nextMonth() {
    setCurrentDate(new Date(year, month + 1, 1));
    setSelectedDate(null);
  }

  // 선택된 날짜의 경기들
  const selectedGames = selectedDate ? gamesByDate.get(selectedDate) || [] : [];

  // 홈팀의 예매 오픈 정보
  const primaryTeamId = stadium.teamIds[0];

  return (
    <div className="space-y-4">
      {/* 예매 오픈 안내 */}
      <GlassCard className="p-4">
        <div className="space-y-2">
          {stadium.teamIds.map((teamId) => {
            const team = getTeamById(teamId);
            return (
              <div key={teamId} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  {team && (
                    <Image src={team.logoPath} alt="" width={20} height={20} unoptimized className="object-contain" />
                  )}
                  <span className="text-text-primary font-medium">{team?.shortName} 예매 오픈</span>
                </div>
                <span className="text-text-secondary text-xs">{TICKET_OPEN_INFO[teamId] || ""}</span>
              </div>
            );
          })}
          <a
            href={stadium.ticketing.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 mt-2 text-accent text-sm font-medium"
          >
            <ExternalLink size={14} />
            {stadium.ticketing.provider} 바로가기
          </a>
        </div>
      </GlassCard>

      {/* 월 네비게이션 */}
      <div className="flex items-center justify-between px-2">
        <button onClick={prevMonth} className="p-2 text-text-secondary">
          <ChevronLeft size={20} />
        </button>
        <h3 className="text-base font-bold text-text-primary">
          {year}년 {month + 1}월
        </h3>
        <button onClick={nextMonth} className="p-2 text-text-secondary">
          <ChevronRight size={20} />
        </button>
      </div>

      {/* 요일 헤더 */}
      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((day, i) => (
          <div
            key={day}
            className={`text-xs font-medium py-1 ${i === 0 ? "text-red-400" : i === 6 ? "text-blue-400" : "text-text-tertiary"}`}
          >
            {day}
          </div>
        ))}
      </div>

      {/* 달력 그리드 */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-text-tertiary" />
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-1">
          {cells.map((day, i) => {
            if (day === null) return <div key={`empty-${i}`} />;

            const dateStr = `${monthKey}${String(day).padStart(2, "0")}`;
            const dayGames = gamesByDate.get(dateStr);
            const hasGame = !!dayGames && dayGames.length > 0;
            const isToday = dateStr === todayStr;
            const isSelected = dateStr === selectedDate;
            const dayOfWeek = (firstDay + day - 1) % 7;

            return (
              <button
                key={dateStr}
                onClick={() => hasGame ? setSelectedDate(isSelected ? null : dateStr) : undefined}
                className={`relative aspect-square rounded-lg flex flex-col items-center justify-center gap-0.5 transition-colors ${
                  isSelected
                    ? "bg-accent/20 ring-1 ring-accent"
                    : hasGame
                    ? "bg-bg-tertiary hover:bg-bg-tertiary/80"
                    : ""
                } ${!hasGame ? "opacity-40" : ""}`}
              >
                <span
                  className={`text-[10px] leading-none ${
                    isToday
                      ? "text-accent font-bold"
                      : dayOfWeek === 0
                      ? "text-red-400"
                      : dayOfWeek === 6
                      ? "text-blue-400"
                      : "text-text-primary"
                  }`}
                >
                  {day}
                </span>
                {hasGame && dayGames && (
                  <div className="flex gap-0.5">
                    {dayGames.slice(0, 2).map((g) => {
                      const awayTeam = getTeamById(g.awayTeamId);
                      return awayTeam ? (
                        <Image
                          key={g.gameId}
                          src={awayTeam.logoPath}
                          alt={awayTeam.shortName}
                          width={24}
                          height={24}
                          unoptimized
                          className="object-contain"
                        />
                      ) : null;
                    })}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* 선택된 날짜 경기 상세 */}
      {selectedDate && selectedGames.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-text-primary px-1">
            {parseInt(selectedDate.slice(4, 6))}월 {parseInt(selectedDate.slice(6, 8))}일 홈경기
          </h4>
          {selectedGames.map((game) => {
            const homeTeam = getTeamById(game.homeTeamId);
            const awayTeam = getTeamById(game.awayTeamId);

            return (
              <GlassCard key={game.gameId} className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      {awayTeam && (
                        <Image src={awayTeam.logoPath} alt="" width={24} height={24} unoptimized className="object-contain" />
                      )}
                      <span className="text-sm font-medium text-text-primary">{game.awayName}</span>
                    </div>
                    <span className="text-xs text-text-tertiary">vs</span>
                    <div className="flex items-center gap-2">
                      {homeTeam && (
                        <Image src={homeTeam.logoPath} alt="" width={24} height={24} unoptimized className="object-contain" />
                      )}
                      <span className="text-sm font-medium text-text-primary">{game.homeName}</span>
                    </div>
                  </div>
                  <span className="text-sm text-text-secondary">{game.time}</span>
                </div>
                <div className="flex items-center justify-between mt-3">
                  <span className="text-xs text-text-tertiary">
                    {game.status === "scheduled" ? "예정" : game.status === "final" ? "종료" : game.status === "cancelled" ? "취소" : "진행중"}
                  </span>
                  {game.status === "scheduled" && (
                    <a
                      href={stadium.ticketing.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white"
                    >
                      <ExternalLink size={12} />
                      예매하기
                    </a>
                  )}
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}

      {/* 하단 홈경기 리스트 (선택 안 됐을 때) */}
      {!selectedDate && !loading && games.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-text-primary px-1">
            {month + 1}월 홈경기 ({games.length}경기)
          </h4>
          {games
            .filter((g) => g.date >= todayStr)
            .slice(0, 5)
            .map((game) => {
              const awayTeam = getTeamById(game.awayTeamId);

              return (
                <GlassCard key={game.gameId} className="p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {awayTeam && (
                        <Image src={awayTeam.logoPath} alt="" width={20} height={20} unoptimized className="object-contain" />
                      )}
                      <span className="text-sm text-text-primary">vs {game.awayName}</span>
                      <span className="text-xs text-text-tertiary">
                        {parseInt(game.date.slice(4, 6))}/{parseInt(game.date.slice(6, 8))} {game.time}
                      </span>
                    </div>
                    {game.status === "scheduled" && (
                      <a
                        href={stadium.ticketing.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-accent font-medium"
                      >
                        예매
                      </a>
                    )}
                  </div>
                </GlassCard>
              );
            })}
        </div>
      )}

      {!loading && games.length === 0 && (
        <div className="text-center py-8">
          <p className="text-sm text-text-tertiary">이번 달 홈경기가 없어요</p>
        </div>
      )}
    </div>
  );
}
