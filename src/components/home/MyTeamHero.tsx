"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { getTeamBgColor } from "@/lib/constants/teams";
import { getTeamShortName, getTeamLogo } from "@/lib/utils/team";

import Diamond from "@/components/game/Diamond";
import type { TeamData } from "@/lib/constants/teams";
import type { BroadcastChannel } from "@/lib/broadcast-channels";
import { pickGameWeather, type GameWeather, type StadiumWeatherMap } from "@/lib/weather/stadium-weather";
import { normalizeCancelReason } from "@/lib/utils/cancel-reason";

interface HomeGame {
  id: string;
  homeTeamId: number;
  awayTeamId: number;
  time: string;
  stadium: string;
  homeScore: number;
  awayScore: number;
  status: "scheduled" | "live" | "final" | "cancelled";
  inning: string | null;
  balls: number;
  strikes: number;
  outs: number;
  runner1b: boolean;
  runner2b: boolean;
  runner3b: boolean;
  currentBatter: string | null;
  currentPitcher: string | null;
  isTop: boolean;
  awayStarterName?: string | null;
  homeStarterName?: string | null;
  winPitcher?: string | null;
  losePitcher?: string | null;
  broadcastChannels?: BroadcastChannel[];
  /** 취소 사유 원문. status=cancelled 일 때만 유의미며, 미수신이면 고정 문구로 fallback. */
  cancelReason?: string | null;
  dateLabel?: string | null; // 예정 경기 날짜 라벨 ('7월 12일 (일)') — 시간 pill에 병기
  dateISO?: string; // 날씨 조회용 경기 날짜 (YYYY-MM-DD)
}

export default function MyTeamHero({ myTeam, myTeamGame, embedded = false }: { myTeam: TeamData; myTeamGame: HomeGame; embedded?: boolean }) {
  const { status, dateISO, stadium, time } = myTeamGame;
  const weatherKey = status === "scheduled" && dateISO && stadium
    ? `${dateISO}|${stadium}|${time}`
    : null;
  const [weatherState, setWeatherState] = useState<{ key: string; value: GameWeather | null } | null>(null);
  const weather = weatherState?.key === weatherKey ? weatherState.value : null;

  useEffect(() => {
    if (!weatherKey || !dateISO) return;

    let cancelled = false;
    fetch(`/api/weather?date=${dateISO.replace(/-/g, "")}&stadiums=${encodeURIComponent(stadium)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { stadiums?: StadiumWeatherMap } | null) => {
        if (cancelled) return;
        setWeatherState({
          key: weatherKey,
          value: pickGameWeather(data?.stadiums?.[stadium], { status, time }, dateISO),
        });
      })
      .catch(() => {
        if (!cancelled) setWeatherState({ key: weatherKey, value: null });
      });

    return () => { cancelled = true; };
  }, [weatherKey, status, dateISO, stadium, time]);

  return (
    <div className={embedded ? "" : "mb-3"}>
      <Link prefetch={false} href={`/games/${myTeamGame.id}`}>
        <div
          className="relative rounded-2xl p-3.5 overflow-hidden myteam-card"
          style={{ ['--team-bg' as string]: getTeamBgColor(myTeam) }}
        >
          {/* Team logo watermark — 팀카드 임베드 시엔 헤더에 이미 있으므로 숨김 */}
          {!embedded && (
            <div className="absolute right-3 top-3 opacity-[0.08] dark:opacity-15">
              <Image src={myTeam.logoPath} alt="" width={64} height={64} unoptimized className="object-contain" />
            </div>
          )}

          {/* Header: MY TEAM — 임베드 시 숨김 */}
          {!embedded && (
            <div className="flex items-center gap-2 mb-2">
              <div className="w-7 h-7 rounded-full bg-bg-tertiary dark:bg-white p-0.5 flex items-center justify-center">
                <Image src={myTeam.logoPath} alt="" width={18} height={18} unoptimized className="object-contain" />
              </div>
              <span className="text-sm leading-[20px] font-bold tracking-wide text-accent">MY TEAM</span>
            </div>
          )}

          {/* Score row */}
          <div className="flex items-center justify-between mb-2">
            <div className="flex flex-col items-center gap-1.5 flex-1">
              <div className="w-8 h-8 rounded-full bg-white p-0.5 flex items-center justify-center">
                <Image src={getTeamLogo(myTeamGame.awayTeamId)} alt="" width={24} height={24} unoptimized className="object-contain" />
              </div>
              <span className="text-sm font-bold leading-none text-accent">{getTeamShortName(myTeamGame.awayTeamId)}</span>
              {myTeamGame.status === "scheduled" && (
                <span className="max-w-full truncate text-[10px] text-text-tertiary">{myTeamGame.awayStarterName || "선발 미정"}</span>
              )}
            </div>
            <div className="flex min-w-0 flex-col items-center gap-1.5 text-center">
              {(myTeamGame.status === "scheduled" || myTeamGame.status === "final") && (
                <div className="text-[10px] text-text-tertiary">🏟 {myTeamGame.stadium}</div>
              )}
              {myTeamGame.status === "scheduled" ? (
                <div className="px-3 py-1 rounded-full bg-accent/10">
                  <span className="text-sm font-semibold text-accent">경기 예정</span>
                </div>
              ) : myTeamGame.status === "cancelled" ? (
                <div className="px-3 py-1 rounded-full bg-white/10">
                  {/* 사유를 받았으면 원문(`우천취소` 등), 못 받았으면 기존 `경기 취소` —
                      부재를 "사유 없음"으로 단정하지 않는다(provenance 계약). */}
                  <span className="text-sm font-semibold text-text-primary">
                    {normalizeCancelReason(myTeamGame.cancelReason) ?? "경기 취소"}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <span className="text-2xl font-black tabular-nums text-text-primary">{myTeamGame.awayScore}</span>
                  <span className="text-sm text-text-tertiary">:</span>
                  <span className="text-2xl font-black tabular-nums text-text-primary">{myTeamGame.homeScore}</span>
                </div>
              )}
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                myTeamGame.status === "live" ? "bg-red-500/20 text-red-400 animate-pulse" :
                myTeamGame.status === "cancelled" ? "bg-text-tertiary/20 text-text-tertiary" :
                myTeamGame.status === "final" ? "bg-text-tertiary/20 text-text-tertiary" :
                "bg-accent/20 text-accent"
              }`}>
                {myTeamGame.status === "live" ? `LIVE ${myTeamGame.inning}` : myTeamGame.status === "cancelled" ? "경기 취소" : myTeamGame.status === "final" ? "경기 종료" : myTeamGame.dateLabel ? `${myTeamGame.dateLabel} ${myTeamGame.time}` : myTeamGame.time}
              </span>
              {myTeamGame.status === "scheduled" && weather && (
                <div
                  className={`whitespace-nowrap text-[10px] ${
                    weather.pop !== null && weather.pop >= 60 ? "font-medium text-amber-400" : "text-text-tertiary"
                  }`}
                  title="경기 시간 기준 예보"
                >
                  {weather.emoji}
                  {weather.temp !== null && ` ${weather.temp}°`}
                  {weather.indoor ? " · 돔" : weather.pop !== null ? ` · 강수 ${weather.pop}%` : ""}
                </div>
              )}
            </div>
            <div className="flex flex-col items-center gap-1.5 flex-1">
              <div className="w-8 h-8 rounded-full bg-white p-0.5 flex items-center justify-center">
                <Image src={getTeamLogo(myTeamGame.homeTeamId)} alt="" width={24} height={24} unoptimized className="object-contain" />
              </div>
              <span className="text-sm font-bold leading-none text-accent">{getTeamShortName(myTeamGame.homeTeamId)}</span>
              {myTeamGame.status === "scheduled" && (
                <span className="max-w-full truncate text-[10px] text-text-tertiary">{myTeamGame.homeStarterName || "선발 미정"}</span>
              )}
            </div>
          </div>

          {/* Live details: BSO + P/AB + Diamond — 한 블록 */}
          {myTeamGame.status === "live" && (
            <div className="flex items-center justify-between pt-2 border-t border-white/10">
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2 text-[11px] font-mono">
                  <span>B <span className="text-green-400">{"●".repeat(myTeamGame.balls)}{"○".repeat(4 - myTeamGame.balls)}</span></span>
                  <span>S <span className="text-yellow-400">{"●".repeat(myTeamGame.strikes)}{"○".repeat(3 - myTeamGame.strikes)}</span></span>
                  <span>O <span className="text-red-400">{"●".repeat(myTeamGame.outs)}{"○".repeat(3 - myTeamGame.outs)}</span></span>
                </div>
                {(myTeamGame.currentPitcher || myTeamGame.currentBatter) && (
                  <div className="text-[10px] text-text-tertiary truncate">
                    {myTeamGame.currentPitcher && <span>P {myTeamGame.currentPitcher}</span>}
                    {myTeamGame.currentBatter && <span className="ml-2">AB {myTeamGame.currentBatter}</span>}
                  </div>
                )}
              </div>
              <Diamond
                runner1b={myTeamGame.runner1b}
                runner2b={myTeamGame.runner2b}
                runner3b={myTeamGame.runner3b}
                teamColor="var(--accent)"
              />
            </div>
          )}

          {/* 종료 모드: 구장은 중앙 상단으로 이동, 승·패투수만 하단 */}
          {myTeamGame.status === "final" && (myTeamGame.winPitcher || myTeamGame.losePitcher) && (
            <div className="pt-2 border-t border-white/10 text-[11px] text-text-tertiary">
              승 {myTeamGame.winPitcher || "-"} · 패 {myTeamGame.losePitcher || "-"}
            </div>
          )}
        </div>
      </Link>
    </div>
  );
}
