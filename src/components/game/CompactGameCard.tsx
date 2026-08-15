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
    // 라이브 상세(잠금화면 Live Activity 패리티) — live 상태에서만 채워진다
    balls?: number;
    strikes?: number;
    outs?: number;
    runnersOn?: { first: boolean; second: boolean; third: boolean };
    currentPitcher?: string;
    currentBatter?: string;
    lastPlay?: string;
  };
}

/** BSO 점 묶음 — 잠금화면 LA outDot과 동일 개념(채워짐=색, 빈=반투명). 팀컴러 미사용. */
function CountDots({ label, count, total, activeClass }: { label: string; count: number; total: number; activeClass: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="w-2.5 text-[10px] font-semibold text-text-tertiary">{label}</span>
      {Array.from({ length: total }).map((_, i) => (
        <span key={i} className={`h-1.5 w-1.5 rounded-full ${i < count ? activeClass : "bg-text-tertiary/25"}`} />
      ))}
    </span>
  );
}

/** 주자 다이아몬드 — 잠금화면 LA DiamondView와 동일 배치(2루 위·1루 우·3루 좌). 팀컴러 미사용. */
function MiniDiamond({ first, second, third }: { first: boolean; second: boolean; third: boolean }) {
  const base = (on: boolean) =>
    `absolute h-2.5 w-2.5 rounded-[2px] ${on ? "bg-red-500" : "border border-text-tertiary/40 bg-text-tertiary/15"}`;
  const onBases = [first && "1루", second && "2루", third && "3루"].filter(Boolean).join("·");
  return (
    <span className="relative block h-7 w-9 shrink-0" role="img" aria-label={`주자 ${onBases || "없음"}`}>
      <span className={base(second)} style={{ left: "50%", top: 0, transform: "translateX(-50%) rotate(45deg)" }} />
      <span className={base(first)} style={{ right: 0, bottom: 4, transform: "rotate(45deg)" }} />
      <span className={base(third)} style={{ left: 0, bottom: 4, transform: "rotate(45deg)" }} />
    </span>
  );
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
  // 예고 선발은 경기 시작 전(예정)에만 노출한다. 라이브는 잠금화면 LA와 동일하게 하단
  // 현재 투수/타자 줄이 대신하므로(세로 압축) 선발 줄을 겹쳐 보여주지 않는다.
  const showStarter = game.status === "scheduled";

  return (
    <Link prefetch={false} href={`/games/${game.id}`}>
      <div className={`glass-card ${isLive ? "p-3" : "p-4"} hover:bg-black/5 dark:hover:bg-white/5 transition-colors ${myTeamId != null && (game.awayTeamId === myTeamId || game.homeTeamId === myTeamId) ? "border-l-[3px] border-l-accent" : ""}`}>
        {/* Status */}
        <div className={`flex items-center justify-between ${isLive ? "mb-1.5" : "mb-3"}`}>
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
            {(game.status === "scheduled" || isLive) && <BroadcastBadges channels={game.broadcastChannels} />}
            <span className="truncate text-xs text-text-tertiary">{game.stadium}</span>
          </div>
        </div>

        {/* Away team row */}
        <div className={`flex items-center justify-between ${isLive ? "py-0.5" : "py-1.5"} ${awayWin ? "" : isFinal ? "opacity-50" : ""}`}>
          <div className="flex items-center gap-3">
            <div className={`${isLive ? "h-7 w-7" : "w-9 h-9"} rounded-full bg-gray-100 dark:bg-white p-1 flex items-center justify-center`}>
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
        <div className={`flex items-center justify-between ${isLive ? "py-0.5" : "py-1.5"} ${homeWin ? "" : isFinal ? "opacity-50" : ""}`}>
          <div className="flex items-center gap-3">
            <div className={`${isLive ? "h-7 w-7" : "w-9 h-9"} rounded-full bg-gray-100 dark:bg-white p-1 flex items-center justify-center`}>
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

        {/* 라이브 상세 — 잠금화면 LA 패리티: BSO + 투수/타자 + 주자 다이아몬드 + 문자중계 한 줄.
            팀컴러 미적용(마이팀 카드 좌측 보더는 기존 그대로), 세로 최소화(2줄 + 티커 1줄). */}
        {isLive && (
          <div className="mt-1 border-t border-border/60 pt-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-2.5">
                  <CountDots label="B" count={Math.max(0, Math.min(game.balls ?? 0, 3))} total={3} activeClass="bg-green-500" />
                  <CountDots label="S" count={Math.max(0, Math.min(game.strikes ?? 0, 2))} total={2} activeClass="bg-yellow-500" />
                  <CountDots label="O" count={Math.max(0, Math.min(game.outs ?? 0, 2))} total={2} activeClass="bg-red-500" />
                </div>
                {(game.currentPitcher || game.currentBatter) && (
                  <div className="truncate text-[11px] leading-tight text-text-secondary">
                    {game.currentPitcher && (
                      <><span className="text-text-tertiary">투수 </span><span className="font-semibold">{game.currentPitcher}</span></>
                    )}
                    {game.currentPitcher && game.currentBatter && <span className="text-text-tertiary"> · </span>}
                    {game.currentBatter && (
                      <><span className="text-text-tertiary">타자 </span><span className="font-semibold">{game.currentBatter}</span></>
                    )}
                  </div>
                )}
              </div>
              <MiniDiamond
                first={game.runnersOn?.first ?? false}
                second={game.runnersOn?.second ?? false}
                third={game.runnersOn?.third ?? false}
              />
            </div>
            {game.lastPlay && (
              <div className="mt-1 flex items-center gap-1.5 rounded-md bg-text-tertiary/10 px-2 py-0.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                <span className="truncate text-[11px] text-text-secondary">{game.lastPlay}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </Link>
  );
}
