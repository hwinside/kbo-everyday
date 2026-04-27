"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { getTeamById } from "@/lib/constants/teams";
import type { Stadium } from "@/lib/constants/stadiums";
import { useAuth } from "@/lib/supabase/AuthContext";
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

/** 구단별 예매 오픈 정보 (구조화) */
interface TicketOpenRule {
  daysBefore: number; // 경기 며칠 전
  hour: number;       // 오픈 시각 (24h)
  maxTickets: number;
  label: string;      // 표시용 텍스트
  provider: string;   // 예매처 이름
  url: string;        // 예매 링크
}

const TICKET_OPEN_RULES: Record<number, TicketOpenRule> = {
  1:  { daysBefore: 7,  hour: 11, maxTickets: 4,  label: "경기 7일 전 오전 11시 (최대 4매)", provider: "티켓링크", url: "https://www.ticketlink.co.kr" },
  2:  { daysBefore: 7,  hour: 11, maxTickets: 4,  label: "경기 7일 전 오전 11시 (최대 4매)", provider: "인터파크", url: "https://ticket.interpark.com" },
  3:  { daysBefore: 7,  hour: 16, maxTickets: 8,  label: "경기 7일 전 오후 4시 (최대 8매)", provider: "티켓링크", url: "https://www.ticketlink.co.kr" },
  4:  { daysBefore: 5,  hour: 11, maxTickets: 6,  label: "경기 5일 전 오전 11시 (최대 6매)", provider: "SSG닷컴", url: "https://www.ssg.com" },
  5:  { daysBefore: 6,  hour: 11, maxTickets: 10, label: "경기 6일 전 오전 11시 (최대 10매)", provider: "NC 다이노스", url: "https://www.ncdinos.com" },
  6:  { daysBefore: 7,  hour: 11, maxTickets: 4,  label: "경기 7일 전 오전 11시 (최대 4매)", provider: "티켓링크", url: "https://www.ticketlink.co.kr" },
  7:  { daysBefore: 14, hour: 14, maxTickets: 8,  label: "경기 14일 전 오후 2시 (최대 8매)", provider: "롯데 자이언츠", url: "https://www.giantsclub.com" },
  8:  { daysBefore: 7,  hour: 11, maxTickets: 6,  label: "경기 7일 전 오전 11시 (최대 6매)", provider: "티켓링크", url: "https://www.ticketlink.co.kr" },
  9:  { daysBefore: 7,  hour: 11, maxTickets: 4,  label: "경기 7일 전 오전 11시 (최대 4매)", provider: "티켓링크", url: "https://www.ticketlink.co.kr" },
  10: { daysBefore: 7,  hour: 14, maxTickets: 4,  label: "경기 7일 전 오후 2시 (최대 4매)", provider: "놀티켓", url: "https://ticket.interpark.com" },
};

/** 경기 날짜 + 구단 오픈 룰 → 예매 오픈 일시 계산 */
function getTicketOpenDate(gameDate: string, teamId: number): Date | null {
  const rule = TICKET_OPEN_RULES[teamId];
  if (!rule) return null;
  const y = parseInt(gameDate.slice(0, 4));
  const m = parseInt(gameDate.slice(4, 6)) - 1;
  const d = parseInt(gameDate.slice(6, 8));
  const game = new Date(y, m, d);
  game.setDate(game.getDate() - rule.daysBefore);
  game.setHours(rule.hour, 0, 0, 0);
  return game;
}

/** 동일 팀·동일일 2경기 이상 = 더블헤더/변경 경기 추정 */
function isDoubleHeader(games: StadiumGame[], game: StadiumGame): boolean {
  return games.filter((g) => g.date === game.date && g.homeTeamId === game.homeTeamId).length >= 2;
}

/** 예매 오픈 일시 포맷 */
function formatOpenDate(date: Date): string {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const h = date.getHours();
  const ampm = h < 12 ? "오전" : "오후";
  const hour12 = h <= 12 ? h : h - 12;
  return `${m}/${d} ${ampm} ${hour12}시`;
}

function getMonthKey(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export default function StadiumCalendar({ stadium }: StadiumCalendarProps) {
  const { profile } = useAuth();
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

  // 마이팀 필터: 마이팀이 홈 또는 원정으로 참여하는 경기만 표시
  const myTeamId = profile?.team_id ?? null;
  const filteredGames = myTeamId
    ? games.filter((g) => g.homeTeamId === myTeamId || g.awayTeamId === myTeamId)
    : games;

  const myTeam = myTeamId ? getTeamById(myTeamId) : null;

  // 마이팀이 구장 소속이면 마이팀 먼저, 그 외는 기본 순서
  const sortedTeamIds = myTeamId && stadium.teamIds.includes(myTeamId)
    ? [myTeamId, ...stadium.teamIds.filter((id) => id !== myTeamId)]
    : stadium.teamIds;

  // 날짜별 경기 맵 (달력 그리드용: 전체 경기)
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
  const selectedGamesAll = selectedDate ? gamesByDate.get(selectedDate) || [] : [];
  const selectedGames = myTeamId
    ? selectedGamesAll.filter((g) => g.homeTeamId === myTeamId || g.awayTeamId === myTeamId)
    : selectedGamesAll;

  return (
    <div className="space-y-4">
      {/* 예매 오픈 안내 */}
      <GlassCard className="p-4">
        <div className="space-y-2">
          {sortedTeamIds.map((teamId) => {
            const team = getTeamById(teamId);
            return (
              <div key={teamId} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  {team && (
                    <Image src={team.logoPath} alt="" width={20} height={20} unoptimized className="object-contain" />
                  )}
                  <span className="text-text-primary font-medium">{team?.shortName} 예매 오픈</span>
                </div>
                <span className="text-text-secondary text-xs">{TICKET_OPEN_RULES[teamId]?.label || ""}</span>
              </div>
            );
          })}
          {sortedTeamIds.map((tid) => {
            const rule = TICKET_OPEN_RULES[tid];
            if (!rule) return null;
            const team = getTeamById(tid);
            return (
              <a
                key={tid}
                href={rule.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 mt-2 text-accent text-sm font-medium"
              >
                <ExternalLink size={14} />
                {stadium.teamIds.length > 1 && team ? `${team.shortName} ` : ""}{rule.provider} 바로가기
              </a>
            );
          })}
        </div>
      </GlassCard>

      {/* 멀티팀 구장 범례 */}
      {stadium.teamIds.length > 1 && (
        <div className="flex items-center gap-4 px-2">
          {sortedTeamIds.map((teamId) => {
            const team = getTeamById(teamId);
            if (!team) return null;
            return (
              <div key={teamId} className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: `${team.colorPrimary}40` }} />
                <span className="text-xs text-text-secondary">{team.shortName} 홈</span>
              </div>
            );
          })}
        </div>
      )}

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
            // 멀티팀 구장: 홈팀 컬러로 배경 구분
            const homeTeam = hasGame && dayGames ? getTeamById(dayGames[0].homeTeamId) : null;
            const hasMultipleTeams = stadium.teamIds.length > 1;
            const cellBg = hasGame && hasMultipleTeams && homeTeam
              ? `${homeTeam.colorPrimary}25`
              : undefined;

            return (
              <button
                key={dateStr}
                onClick={() => hasGame ? setSelectedDate(isSelected ? null : dateStr) : undefined}
                style={cellBg && !isSelected ? { backgroundColor: cellBg } : undefined}
                className={`relative aspect-square rounded-lg flex flex-col items-center justify-center gap-0.5 transition-colors ${
                  isSelected
                    ? "bg-accent/20 ring-1 ring-accent"
                    : hasGame && !hasMultipleTeams
                    ? "bg-bg-tertiary hover:bg-bg-tertiary/80"
                    : hasGame
                    ? "hover:opacity-80"
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
                      const isMyGame = myTeamId ? (g.homeTeamId === myTeamId || g.awayTeamId === myTeamId) : false;
                      return awayTeam ? (
                        <Image
                          key={g.gameId}
                          src={awayTeam.logoPath}
                          alt={awayTeam.shortName}
                          width={24}
                          height={24}
                          unoptimized
                          className={`object-contain ${isMyGame ? "ring-2 ring-accent rounded-full" : "opacity-50"}`}
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
                  <div>
                    <span className="text-xs text-text-tertiary">
                      {game.status === "scheduled" ? "예정" : game.status === "final" ? "종료" : game.status === "cancelled" ? "취소" : "진행중"}
                    </span>
                    {game.status === "scheduled" && (() => {
                      if (isDoubleHeader(games, game)) {
                        return <span className="text-xs ml-2 text-yellow-400">변경 경기 · 예매 일정 별도 확인</span>;
                      }
                      const openDate = getTicketOpenDate(game.date, game.homeTeamId);
                      if (!openDate) return null;
                      const now = new Date();
                      const isOpen = now >= openDate;
                      return (
                        <span className={`text-xs ml-2 ${isOpen ? "text-green-400 font-medium" : "text-text-tertiary"}`}>
                          {isOpen ? "예매 오픈됨" : `예매 오픈: ${formatOpenDate(openDate)}`}
                        </span>
                      );
                    })()}
                  </div>
                  {game.status === "scheduled" && TICKET_OPEN_RULES[game.homeTeamId] && (
                    <a
                      href={TICKET_OPEN_RULES[game.homeTeamId].url}
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
      {!selectedDate && !loading && filteredGames.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-text-primary px-1">
            {month + 1}월 {myTeam ? `${myTeam.shortName} ` : ""}경기 ({filteredGames.length}경기)
          </h4>
          {filteredGames
            .filter((g) => g.date >= todayStr)
            .slice(0, 5)
            .map((game) => {
              // 마이팀이 원정이면 상대 = homeTeam, 그 외 상대 = awayTeam
              const isMyAway = myTeamId === game.awayTeamId;
              const opponentId = isMyAway ? game.homeTeamId : game.awayTeamId;
              const opponentName = isMyAway ? game.homeName : game.awayName;
              const opponent = getTeamById(opponentId);

              const isDH = isDoubleHeader(games, game);
              const openDate = isDH ? null : getTicketOpenDate(game.date, game.homeTeamId);
              const now = new Date();
              const isOpen = openDate ? now >= openDate : false;

              return (
                <GlassCard key={game.gameId} className="p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {opponent && (
                        <Image src={opponent.logoPath} alt="" width={20} height={20} unoptimized className="object-contain" />
                      )}
                      <span className="text-sm text-text-primary">vs {opponentName}{isMyAway ? " (원정)" : ""}</span>
                      <span className="text-xs text-text-tertiary">
                        {parseInt(game.date.slice(4, 6))}/{parseInt(game.date.slice(6, 8))} {game.time}
                      </span>
                    </div>
                    {game.status === "scheduled" && (
                      <a
                        href={TICKET_OPEN_RULES[game.homeTeamId]?.url || stadium.ticketing.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-accent font-medium"
                      >
                        예매
                      </a>
                    )}
                  </div>
                  {game.status === "scheduled" && (
                    <div className="mt-1.5">
                      {isDH ? (
                        <span className="text-[11px] text-yellow-400">변경 경기 · 예매 일정 별도 확인</span>
                      ) : openDate ? (
                        <span className={`text-[11px] ${isOpen ? "text-green-400" : "text-text-tertiary"}`}>
                          {isOpen ? "예매 오픈됨" : `예매 오픈: ${formatOpenDate(openDate)}`}
                        </span>
                      ) : null}
                    </div>
                  )}
                </GlassCard>
              );
            })}
        </div>
      )}

      {!loading && filteredGames.length === 0 && (
        <div className="text-center py-8">
          <p className="text-sm text-text-tertiary">이번 달 홈경기가 없어요</p>
        </div>
      )}
    </div>
  );
}
