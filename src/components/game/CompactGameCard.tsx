"use client";

import Image from "next/image";
import Link from "next/link";
import { getTeamById } from "@/lib/constants/teams";
import type { BroadcastChannel } from "@/lib/broadcast-channels";
import type { GameWeather } from "@/lib/weather/stadium-weather";
import BroadcastBadges from "@/components/game/BroadcastBadges";

interface CompactGameCardProps {
  isPreseason?: boolean;
  myTeamId?: number | null;
  /** 경기 시간 기준 구장 날씨 (예정=예보, 라이브=실시간). null/undefined면 미노출 */
  weather?: GameWeather | null;
  /**
   * 오늘이 아닌 날짜의 경기를 오늘 화면에 얹어 보여줄 때(MY TEAM 다음 경기 카드) 넘긴다.
   * "YYYY-MM-DD". 넘기면 시간 배지 앞에 날짜를 함께 찍어 오늘 경기로 오독되지 않게 한다.
   */
  dateStr?: string;
  game: {
    id: string;
    awayTeamId: number;
    homeTeamId: number;
    awayScore: number | null;
    homeScore: number | null;
    status: "scheduled" | "live" | "final" | "cancelled";
    inning?: string;
    time: string;
    stadium: string;
    broadcastChannels?: BroadcastChannel[];
    awayStarter?: string;
    homeStarter?: string;
  };
}

/** "YYYY-MM-DD" → "8/4(화)" — 카드 배지용 초압축 표기 */
function formatBadgeDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${weekday})`;
}

export default function CompactGameCard({ game, isPreseason, myTeamId, weather, dateStr }: CompactGameCardProps) {
  const away = getTeamById(game.awayTeamId)!;
  const home = getTeamById(game.homeTeamId)!;
  const isLive = game.status === "live";
  const isFinal = game.status === "final";
  const isCancelled = game.status === "cancelled";
  const awayWin = isFinal && (game.awayScore ?? 0) > (game.homeScore ?? 0);
  const homeWin = isFinal && (game.homeScore ?? 0) > (game.awayScore ?? 0);
  // 예고 선발은 경기 시작 전(예정)·진행 중에만 의미가 있다. KBO가 보통 전날 저녁에 공시하므로
  // 먼 경기는 비어 있을 수 있어, 이름이 있을 때만 노출한다.
  const showStarter = game.status === "scheduled" || game.status === "live";

  return (
    <Link prefetch={false} href={`/games/${game.id}`}>
      <div className={`glass-card p-4 hover:bg-black/5 dark:hover:bg-white/5 transition-colors ${myTeamId != null && (game.awayTeamId === myTeamId || game.homeTeamId === myTeamId) ? "border-l-[3px] border-l-accent" : ""}`}>
        {/* Status */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
              isLive ? "bg-red-500/20 text-red-400 animate-pulse" :
              isCancelled ? "bg-text-tertiary/20 text-text-tertiary" :
              isFinal ? "bg-text-tertiary/20 text-text-tertiary" :
              "bg-accent/20 text-accent"
            }`}>
              {isLive
                ? `LIVE ${game.inning}`
                : isCancelled
                  ? "취소"
                  : isFinal
                    ? "종료"
                    : dateStr
                      ? `${formatBadgeDate(dateStr)} ${game.time}`
                      : game.time}
            </span>
            {isPreseason && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-500">시범경기</span>
            )}
            {(game.status === "scheduled" || isLive) && weather && (
              <span
                className={`whitespace-nowrap text-[11px] ${
                  weather.pop !== null && weather.pop >= 60 ? "font-medium text-amber-400" : "text-text-tertiary"
                }`}
                title={isLive ? "실시간 구장 날씨" : "경기 시간 기준 예보"}
              >
                {weather.emoji}
                {weather.temp !== null && ` ${weather.temp}°`}
                {weather.indoor ? " · 돔" : weather.pop !== null ? ` · 강수 ${weather.pop}%` : ""}
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            {game.status === "scheduled" && <BroadcastBadges channels={game.broadcastChannels} />}
            <span className="truncate text-xs text-text-tertiary">{game.stadium}</span>
          </div>
        </div>

        {/* Away team row */}
        <div className={`flex items-center justify-between py-1.5 ${awayWin ? "" : isFinal ? "opacity-50" : ""}`}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-gray-100 dark:bg-white p-1 flex items-center justify-center">
              <Image src={away.logoPath} alt="" width={24} height={24} unoptimized className="object-contain" />
            </div>
            <div className="flex flex-col">
              <span className={`text-sm font-semibold ${awayWin ? "text-text-primary" : "text-text-secondary"}`}>
                {away.shortName}
              </span>
              {showStarter && game.awayStarter && (
                <span className="text-[11px] leading-tight text-text-tertiary">선발 {game.awayStarter}</span>
              )}
            </div>
          </div>
          {game.status === "scheduled" ? (
            <span className="text-xs font-medium text-accent">예정</span>
          ) : game.status === "cancelled" ? (
            <span className="text-xs font-medium text-text-tertiary">취소</span>
          ) : (
            <span className={`text-lg font-bold tabular-nums ${awayWin ? "text-text-primary" : "text-text-secondary"}`}>
              {game.awayScore}
            </span>
          )}
        </div>

        {/* Home team row */}
        <div className={`flex items-center justify-between py-1.5 ${homeWin ? "" : isFinal ? "opacity-50" : ""}`}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-gray-100 dark:bg-white p-1 flex items-center justify-center">
              <Image src={home.logoPath} alt="" width={24} height={24} unoptimized className="object-contain" />
            </div>
            <div className="flex flex-col">
              <span className={`text-sm font-semibold ${homeWin ? "text-text-primary" : "text-text-secondary"}`}>
                {home.shortName}
              </span>
              {showStarter && game.homeStarter && (
                <span className="text-[11px] leading-tight text-text-tertiary">선발 {game.homeStarter}</span>
              )}
            </div>
          </div>
          {game.status === "scheduled" ? (
            <span className="text-xs font-medium text-accent">예정</span>
          ) : game.status === "cancelled" ? (
            <span className="text-xs font-medium text-text-tertiary">취소</span>
          ) : (
            <span className={`text-lg font-bold tabular-nums ${homeWin ? "text-text-primary" : "text-text-secondary"}`}>
              {game.homeScore}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
