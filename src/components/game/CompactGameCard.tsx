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

/**
 * BSO 점 한 묶음 — 잠금화면 LA outDot과 동일 개념(채워짐=색, 빈=반투명). 팀컬러 미사용.
 * 빈 점은 `bg-white/*` 같은 고정 흰색 대신 semantic token 기반으로 칠해야 라이트모드에서도 보인다.
 */
function CountGroup({ label, count, total, activeClass }: { label: string; count: number; total: number; activeClass: string }) {
  return (
    <span className="flex items-center gap-[2.5px]">
      <span className="text-[8.5px] font-extrabold leading-none text-text-tertiary">{label}</span>
      {Array.from({ length: total }).map((_, i) => (
        <span key={i} className={`h-[5px] w-[5px] rounded-full ${i < count ? activeClass : "bg-text-tertiary/30"}`} />
      ))}
    </span>
  );
}

/** 주자 다이아몬드 — 잠금화면 LA DiamondView와 동일 배치(2루 위·1루 우·3루 좌). 팀컬러 미사용. */
function MiniDiamond({ first, second, third }: { first: boolean; second: boolean; third: boolean }) {
  const cls = (on: boolean) =>
    `absolute h-2 w-2 rotate-45 rounded-[2px] border ${on ? "border-red-500 bg-red-500" : "border-text-tertiary/40 bg-text-tertiary/15"}`;
  const onBases = [first && "1루", second && "2루", third && "3루"].filter(Boolean).join("·");
  return (
    <span className="relative block h-5 w-[26px] shrink-0" role="img" aria-label={`주자 ${onBases || "없음"}`}>
      <span className={cls(second)} style={{ left: "50%", top: 0, marginLeft: -4 }} />
      <span className={cls(first)} style={{ right: 0, bottom: 2 }} />
      <span className={cls(third)} style={{ left: 0, bottom: 2 }} />
    </span>
  );
}

/**
 * 팀 로고 — 행2 고정 트랙(22px)에 직접 올린다.
 * 카드마다 팀명 길이가 달라도 로고 x좌표가 흔들리지 않게 하려면 고정폭 그리드 트랙이어야 한다
 * (flex 배치에서는 형제 콘텐츠 길이가 로고 위치를 밀어버린다).
 */
function TeamLogo({ src }: { src: string }) {
  return (
    <span className="h-[22px] w-[22px] rounded-full bg-white p-0.5">
      <Image src={src} alt="" width={22} height={22} unoptimized className="h-full w-full object-contain" />
    </span>
  );
}

/** 승팀 표시 점 — 종료 카드에서만. */
function WinDot() {
  return <span className="inline-block h-1 w-1 shrink-0 rounded-full bg-emerald-400 align-middle" />;
}

export default function CompactGameCard({ game, isPreseason, myTeamId, weather, dateStr, featured }: CompactGameCardProps) {
  const away = getTeamById(game.awayTeamId)!;
  const home = getTeamById(game.homeTeamId)!;
  const isLive = game.status === "live";
  const isFinal = game.status === "final";
  const isCancelled = game.status === "cancelled";
  const isScheduled = game.status === "scheduled";
  const awayWin = isFinal && (game.awayScore ?? 0) > (game.homeScore ?? 0);
  const homeWin = isFinal && (game.homeScore ?? 0) > (game.awayScore ?? 0);
  const showScore = isLive || isFinal;
  // MY TEAM 섹션 카드에만 팀컬러. 팀컬러가 없으면(마이팀 미설정) 중립으로 떨어진다.
  // 비최상단 마이팀 경기(더블헤더 2차전 등)에는 accent 보더를 두지 않는다 —
  // 하린아빠 지시가 "팀컬러는 맨 위 마이팀만"이므로 목록 카드는 전부 중립이어야 한다.
  const featuredTeam = featured && myTeamId != null ? getTeamById(myTeamId) : undefined;

  // 라이브 상세(BSO·주자·투·타)가 아직 내려오지 않은 경우가 있다.
  // 이때 0-0-0 · 빈 다이아몬드를 그리면 "볼카운트 0-0, 주자 없음"이라는 거짓 사실을 단정하게 된다.
  // 값이 하나라도 있을 때만 카운트/주자를 그리고, 없으면 준비 중으로 표시한다.
  const hasCountDetail =
    game.balls !== undefined || game.strikes !== undefined || game.outs !== undefined || game.runnersOn !== undefined;
  const hasMatchupDetail = Boolean(game.currentPitcher || game.currentBatter);
  const hasLiveDetail = hasCountDetail || hasMatchupDetail;

  return (
    <Link prefetch={false} href={`/games/${game.id}`}>
      <div
        className={`relative overflow-hidden rounded-xl border px-2.5 pb-1.5 pt-[5px] transition-colors ${
          featuredTeam
            ? // MY TEAM 카드도 보더 박스를 유지하고 색만 투명하게 한다.
              // border를 없애면 내부 콘텐츠가 다른 카드보다 1px 안쪽으로 밀려 로고 정렬이 깨진다.
              "border-transparent"
            : "glass-card border-transparent hover:bg-black/5 dark:hover:bg-white/5"
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
              // 예정 pill은 라이트모드에서 흰 배경이 사라지므로 semantic token 기반으로 칠한다.
              "bg-text-tertiary/15 text-text-primary"
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

        {/*
          행2 — 양팀 한 줄 병합. 5열 *고정폭* 그리드로 로고 위치를 콘텐츠와 분리한다:
          [로고 22][원정명 50][스코어 68][홈명 50][로고 22], column-gap 2px, 전체를 가운데 정렬.
          팀명 트랙이 고정폭이라 카드가 달라도 로고·스코어의 x좌표가 항상 동일하다.
        */}
        <div
          className="grid h-[30px] items-center justify-center gap-x-0.5"
          style={{ gridTemplateColumns: "22px 50px 68px 50px 22px" }}
        >
          <TeamLogo src={away.logoPath} />

          <span className="flex w-full min-w-0 flex-col items-center leading-[1.15]">
            <span className={`max-w-full truncate text-[12.5px] ${awayWin || !isFinal ? "font-bold text-text-primary" : "font-semibold text-text-tertiary"}`}>
              {away.shortName}
              {awayWin && <> <WinDot /></>}
            </span>
            {isScheduled && (
              <span className="max-w-full truncate text-[9.5px] text-text-tertiary" title={game.awayStarter || "미정"}>
                선발 {game.awayStarter || "미정"}
              </span>
            )}
          </span>

          <span className="flex items-center justify-center gap-1">
            {showScore ? (
              <>
                <span className={`text-[20px] font-extrabold leading-none tracking-[-0.5px] tabular-nums ${awayWin || !isFinal ? "" : "text-text-tertiary"}`}>
                  {game.awayScore ?? 0}
                </span>
                <span className="text-xs font-bold text-text-tertiary/70">:</span>
                <span className={`text-[20px] font-extrabold leading-none tracking-[-0.5px] tabular-nums ${homeWin || !isFinal ? "" : "text-text-tertiary"}`}>
                  {game.homeScore ?? 0}
                </span>
              </>
            ) : isCancelled ? (
              <span className="text-[11px] font-bold text-text-tertiary">취소</span>
            ) : (
              <span className="text-[10px] font-extrabold text-text-tertiary">VS</span>
            )}
          </span>

          <span className="flex w-full min-w-0 flex-col items-center leading-[1.15]">
            <span className={`max-w-full truncate text-[12.5px] ${homeWin || !isFinal ? "font-bold text-text-primary" : "font-semibold text-text-tertiary"}`}>
              {homeWin && <><WinDot /> </>}
              {home.shortName}
            </span>
            {isScheduled && (
              <span className="max-w-full truncate text-[9.5px] text-text-tertiary" title={game.homeStarter || "미정"}>
                선발 {game.homeStarter || "미정"}
              </span>
            )}
          </span>

          <TeamLogo src={home.logoPath} />
        </div>

        {/*
          행3 — 라이브 전용: 좌 BSO · 중앙 투/타 · 우 주자 다이아몬드 (폭 전체를 3분할).
          라이브 카드는 상세/문자중계 유무와 무관하게 항상 행3·행4를 렌더해 높이를 고정한다
          (조건부로 빼면 같은 목록 안에서 라이브 카드 높이가 들쭉날쭉해진다).
        */}
        {isLive && (
          <div className="mt-px flex h-[22px] items-center gap-2 border-t border-text-tertiary/15 pt-0.5">
            {hasLiveDetail ? (
              <>
                {hasCountDetail ? (
                  <span className="flex shrink-0 items-center gap-[7px]">
                    <CountGroup label="B" count={Math.max(0, Math.min(game.balls ?? 0, 3))} total={3} activeClass="bg-emerald-400" />
                    <CountGroup label="S" count={Math.max(0, Math.min(game.strikes ?? 0, 2))} total={2} activeClass="bg-amber-400" />
                    <CountGroup label="O" count={Math.max(0, Math.min(game.outs ?? 0, 2))} total={2} activeClass="bg-red-500" />
                  </span>
                ) : (
                  <span className="shrink-0" />
                )}
                <span className="flex-1" />
                {hasMatchupDetail && (
                  <span className="min-w-0 truncate text-[10.5px] text-text-secondary">
                    {game.currentPitcher && (
                      <><span className="text-text-tertiary">투 </span><span className="font-bold text-text-primary">{game.currentPitcher}</span></>
                    )}
                    {game.currentPitcher && game.currentBatter && <span className="text-text-tertiary"> · </span>}
                    {game.currentBatter && (
                      <><span className="text-text-tertiary">타 </span><span className="font-bold text-text-primary">{game.currentBatter}</span></>
                    )}
                  </span>
                )}
                <span className="flex-1" />
                {hasCountDetail ? (
                  <MiniDiamond
                    first={game.runnersOn?.first ?? false}
                    second={game.runnersOn?.second ?? false}
                    third={game.runnersOn?.third ?? false}
                  />
                ) : (
                  <span className="h-5 w-[26px] shrink-0" />
                )}
              </>
            ) : (
              // 상세가 아직 없는 상태에서 0-0-0·빈 다이아몬드를 그리면 없는 사실을 단정하게 된다.
              <span className="flex-1 text-center text-[10.5px] text-text-tertiary">실시간 상세 준비 중</span>
            )}
          </div>
        )}

        {/* 행4 — 라이브 전용: 문자중계 최근 플레이 full-width 티커 (없어도 자리는 유지) */}
        {isLive && (
          <div className="mt-[3px] flex h-4 items-center gap-[5px] rounded-[5px] bg-text-tertiary/10 px-1.5">
            <span className={`h-1 w-1 shrink-0 rounded-full ${game.lastPlay ? "bg-red-400" : "bg-text-tertiary/50"}`} />
            <span className={`min-w-0 flex-1 truncate text-[10.5px] ${game.lastPlay ? "text-text-secondary" : "text-text-tertiary"}`}>
              {game.lastPlay || "문자중계 대기 중"}
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}
