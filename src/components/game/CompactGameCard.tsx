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
  /** 경기 시간 기준 구장 날씨 (예정=예보, 라이브=실시간, 종료=경기시각 검증값). null/undefined면 미노출 */
  weather?: GameWeather | null;
  /**
   * 오늘이 아닌 날짜의 경기를 오늘 화면에 얹어 보여줄 때(MY TEAM 다음 경기 카드) 넘긴다.
   * "YYYY-MM-DD". 넘기면 시간 배지 앞에 날짜를 함께 찍어 오늘 경기로 오독되지 않게 한다.
   */
  dateStr?: string;
  /**
   * 최상단 MY TEAM 섹션 카드에서만 true. 이 카드만 팀컬러 그라디언트 + 로고 워터마크를 입힌다
   * (하린아빠 2026-08-15: "팀컬러는 맨 위 마이팀을 제외하고 적용하지 말고").
   * 나머지 카드는 전부 중립 배경으로 통일한다.
   */
  featured?: boolean;
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

/** "YYYY-MM-DD" → "8/4(화)" — 카드 배지용 초압축 표기 */
function formatBadgeDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${weekday})`;
}

/** BSO 점 한 줄 — 잠금화면 LA outDot과 동일 개념(채워짐=색, 빈=반투명). 팀컬러 미사용. */
function CountRow({ label, count, total, activeClass }: { label: string; count: number; total: number; activeClass: string }) {
  return (
    <span className="flex h-[8px] items-center gap-[2.5px]">
      <span className="w-[6px] text-[8px] font-extrabold leading-[8px] text-text-tertiary">{label}</span>
      {Array.from({ length: total }).map((_, i) => (
        <span key={i} className={`h-[4.5px] w-[4.5px] rounded-full ${i < count ? activeClass : "bg-text-tertiary/25"}`} />
      ))}
    </span>
  );
}

/** 주자 다이아몬드 — 잠금화면 LA DiamondView와 동일 배치(2루 위·1루 우·3루 좌). 팀컬러 미사용. */
function MiniDiamond({ first, second, third }: { first: boolean; second: boolean; third: boolean }) {
  const cls = (on: boolean) =>
    `absolute h-2 w-2 rotate-45 rounded-[2px] ${on ? "bg-red-500" : "border border-text-tertiary/30 bg-text-tertiary/10"}`;
  const onBases = [first && "1루", second && "2루", third && "3루"].filter(Boolean).join("·");
  return (
    <span className="relative block h-[22px] w-[26px] shrink-0" role="img" aria-label={`주자 ${onBases || "없음"}`}>
      <span className={cls(second)} style={{ left: "50%", top: 0, marginLeft: -4 }} />
      <span className={cls(first)} style={{ right: 0, bottom: 3 }} />
      <span className={cls(third)} style={{ left: 0, bottom: 3 }} />
    </span>
  );
}

export default function CompactGameCard({ game, isPreseason, myTeamId, weather, dateStr, featured }: CompactGameCardProps) {
  const away = getTeamById(game.awayTeamId)!;
  const home = getTeamById(game.homeTeamId)!;
  const isLive = game.status === "live";
  const isFinal = game.status === "final";
  const isCancelled = game.status === "cancelled";
  const awayWin = isFinal && (game.awayScore ?? 0) > (game.homeScore ?? 0);
  const homeWin = isFinal && (game.homeScore ?? 0) > (game.awayScore ?? 0);
  const showScore = isLive || isFinal;
  // MY TEAM 섹션 카드에만 팀컬러. 팀컬러가 없으면(마이팀 미설정) 중립으로 떨어진다.
  const featuredTeam = featured && myTeamId != null ? getTeamById(myTeamId) : undefined;
  // 더블헤더 2차전처럼 목록에 남은 마이팀 경기는 좌측 accent 보더로만 구분(팀컬러 아님).
  const accentEdge =
    !featuredTeam && myTeamId != null && (game.awayTeamId === myTeamId || game.homeTeamId === myTeamId);

  return (
    <Link prefetch={false} href={`/games/${game.id}`}>
      <div
        className={`relative overflow-hidden rounded-xl px-[9px] pb-1.5 pt-[5px] transition-colors ${
          featuredTeam
            ? ""
            : `glass-card hover:bg-black/5 dark:hover:bg-white/5 ${accentEdge ? "border-l-[3px] border-l-accent" : ""}`
        }`}
        style={featuredTeam ? { background: `linear-gradient(135deg, ${featuredTeam.colorPrimary} 0%, var(--bg-tertiary) 78%)` } : undefined}
      >
        {featuredTeam && (
          <span className="pointer-events-none absolute right-1.5 top-1 h-[46px] w-[46px] opacity-10">
            <Image src={featuredTeam.logoPath} alt="" width={46} height={46} unoptimized className="h-full w-full object-contain brightness-0 invert" />
          </span>
        )}

        {/* 행1 — 상태 pill · 날씨 · 방송사 · 구장 */}
        <div className="flex h-[15px] items-center gap-[5px]">
          <span
            className={`rounded-full px-1.5 text-[10px] font-extrabold leading-[15px] ${
              isLive ? "bg-red-500/90 text-white" :
              isCancelled ? "bg-text-tertiary/20 text-text-tertiary" :
              isFinal ? "bg-text-tertiary/15 text-text-tertiary" :
              "bg-white/15 text-text-primary"
            }`}
          >
            {isLive ? `LIVE ${game.inning}` : isCancelled ? "취소" : isFinal ? "종료" : dateStr ? `${formatBadgeDate(dateStr)} ${game.time}` : game.time}
          </span>
          {isPreseason && (
            <span className="rounded bg-yellow-500/15 px-1 text-[9px] font-medium leading-[14px] text-yellow-500">시범</span>
          )}
          {/* 날씨 — 예정=경기시각 예보, 라이브=실시간, 종료=경기시각 검증값. 값 없으면 렌더 안 함 */}
          {weather && !isCancelled && (
            <span
              className={`whitespace-nowrap text-[10px] ${
                weather.pop !== null && weather.pop >= 60 ? "font-semibold text-amber-400" : "text-text-tertiary"
              }`}
              title={isLive ? "실시간 구장 날씨" : "경기 시간 기준 예보"}
            >
              {weather.emoji}
              {weather.temp !== null && ` ${weather.temp}°`}
              {weather.indoor ? " · 돔" : weather.pop !== null && !isFinal ? ` · ${weather.pop}%` : ""}
            </span>
          )}
          <span className="flex-1" />
          <BroadcastBadges channels={game.broadcastChannels} compact />
          <span className="whitespace-nowrap text-[10px] text-text-tertiary">{game.stadium}</span>
        </div>

        {/* 행2 — 양팀 한 줄 병합(원정 로고·명 · 점수/선발 · 홈 명·로고) + 라이브 BSO·다이아몬드 */}
        <div className="flex h-[29px] items-center gap-2">
          <span className="flex min-w-0 items-center gap-[5px]">
            <span className="h-5 w-5 shrink-0 rounded-full bg-gray-100 p-0.5 dark:bg-white">
              <Image src={away.logoPath} alt="" width={20} height={20} unoptimized className="h-full w-full object-contain" />
            </span>
            <span className={`text-xs font-bold ${awayWin || !isFinal ? "text-text-primary" : "text-text-tertiary"}`}>{away.shortName}</span>
            {awayWin && <span className="h-1 w-1 shrink-0 rounded-full bg-emerald-400" />}

            {showScore ? (
              <>
                <span className={`text-[18px] font-extrabold leading-none tabular-nums ${awayWin || !isFinal ? "" : "text-text-tertiary"}`}>
                  {game.awayScore ?? 0}
                </span>
                <span className="text-xs font-bold text-text-tertiary/70">:</span>
                <span className={`text-[18px] font-extrabold leading-none tabular-nums ${homeWin || !isFinal ? "" : "text-text-tertiary"}`}>
                  {game.homeScore ?? 0}
                </span>
              </>
            ) : isCancelled ? (
              <span className="px-1 text-[11px] font-bold text-text-tertiary">취소</span>
            ) : (
              <>
                <span className="truncate text-[11px] text-text-secondary">{game.awayStarter || "미정"}</span>
                <span className="px-px text-[11px] font-bold text-text-tertiary">vs</span>
                <span className="truncate text-[11px] text-text-secondary">{game.homeStarter || "미정"}</span>
              </>
            )}

            {homeWin && <span className="h-1 w-1 shrink-0 rounded-full bg-emerald-400" />}
            <span className={`text-xs font-bold ${homeWin || !isFinal ? "text-text-primary" : "text-text-tertiary"}`}>{home.shortName}</span>
            <span className="h-5 w-5 shrink-0 rounded-full bg-gray-100 p-0.5 dark:bg-white">
              <Image src={home.logoPath} alt="" width={20} height={20} unoptimized className="h-full w-full object-contain" />
            </span>
          </span>

          {isLive && (
            <>
              <span className="flex-1" />
              <span className="flex shrink-0 flex-col gap-px">
                <CountRow label="B" count={Math.max(0, Math.min(game.balls ?? 0, 3))} total={3} activeClass="bg-emerald-400" />
                <CountRow label="S" count={Math.max(0, Math.min(game.strikes ?? 0, 2))} total={2} activeClass="bg-amber-400" />
                <CountRow label="O" count={Math.max(0, Math.min(game.outs ?? 0, 2))} total={2} activeClass="bg-red-500" />
              </span>
              <MiniDiamond
                first={game.runnersOn?.first ?? false}
                second={game.runnersOn?.second ?? false}
                third={game.runnersOn?.third ?? false}
              />
            </>
          )}
        </div>

        {/* 행3 — 라이브 전용: 현재 투수/타자 + 문자중계 최근 플레이 한 줄 */}
        {isLive && (
          <div className="mt-px flex h-[17px] items-center gap-[5px]">
            {(game.currentPitcher || game.currentBatter) && (
              <span className="whitespace-nowrap text-[10.5px] text-text-secondary">
                {game.currentPitcher && (
                  <><span className="text-text-tertiary">투 </span><span className="font-bold text-text-primary">{game.currentPitcher}</span></>
                )}
                {game.currentPitcher && game.currentBatter && <span className="text-text-tertiary"> · </span>}
                {game.currentBatter && (
                  <><span className="text-text-tertiary">타 </span><span className="font-bold text-text-primary">{game.currentBatter}</span></>
                )}
              </span>
            )}
            {game.lastPlay && (
              <span className="flex h-4 min-w-0 flex-1 items-center gap-1 rounded-[5px] bg-text-tertiary/10 px-1.5">
                <span className="h-1 w-1 shrink-0 rounded-full bg-red-400" />
                <span className="truncate text-[10.5px] text-text-secondary">{game.lastPlay}</span>
              </span>
            )}
          </div>
        )}
      </div>
    </Link>
  );
}
