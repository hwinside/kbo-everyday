"use client";
import Link from "next/link";
import { useState, useEffect, useRef } from "react";

import { clsx } from "clsx";
import { type TeamData, isAllStarGame, getTeamById } from "@/lib/constants/teams";
import { findAllStarEntryByName } from "@/lib/constants/allstar-2026";
import type { GameLineup } from "@/lib/constants/games";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { getCanonicalPlayerHref } from "@/lib/utils/resolve-player";

// 선수 링크 SSOT: 레거시/숫자 외국인 ID/짧은이름을 canonical player로 정규화.
function resolvePlayerHref(batter: { name: string; kboId?: string; teamId?: number }): string {
  return getCanonicalPlayerHref(batter) ?? `/community/players/${encodeURIComponent(batter.name)}`;
}

/** 0.333 → .333, 1.000 → 1.000 */
function formatAvg(avg: string): string {
  const num = parseFloat(avg);
  if (isNaN(num)) return avg;
  if (num >= 1) return avg;
  return avg.replace(/^0\./, ".");
}

interface LineupAnalysis {
  battery: string;
  lineup: string;
  rotation?: string;
}

interface LineupTabProps {
  lineup: GameLineup;
  awayTeam: TeamData;
  homeTeam: TeamData;
  gameId: string;
  isLineupConfirmed: boolean;
}

function PitcherCard({
  name,
  era,
  teamColor,
  teamId,
  kboId,
  label,
  subLabel,
}: {
  name: string;
  era: string;
  teamColor: string;
  teamId: number;
  kboId?: string;
  label: string;
  /** 올스타전: 선수 원소속 팀명 병기 */
  subLabel?: { text: string; color: string };
}) {
  // 선발투수도 타순 선수처럼 카드 클릭 시 선수 상세로 이동 (이름 있을 때만 링크).
  const href = name ? resolvePlayerHref({ name, kboId, teamId }) : null;
  const inner = (
    <>
      <div className="text-base text-text-tertiary mb-2">{label}</div>
      <PlayerAvatar
        name={name}
        teamId={teamId}
        photoUrl={getPlayerPhotoUrl(name, kboId, teamId)}
        size={56}
        showTeamBadge={true}
      />
      <div
        className="inline-flex items-center gap-3 px-4 py-1.5 rounded-full text-white text-sm font-semibold mt-2"
        style={{ backgroundColor: teamColor }}
      >
        <span>SP</span>
        <span>{name}</span>
      </div>
      {subLabel && (
        <div className="text-xs font-semibold mt-1" style={{ color: subLabel.color }}>{subLabel.text}</div>
      )}
      <div className="text-sm text-text-secondary mt-1 tabular-nums">
        ERA {era}
      </div>
    </>
  );
  return href ? (
    <Link href={href} prefetch={false} className="text-center flex flex-col items-center hover:opacity-80">
      {inner}
    </Link>
  ) : (
    <div className="text-center flex flex-col items-center">{inner}</div>
  );
}

function AiLineupAnalysisCard({
  gameId,
  awayTeamId,
  homeTeamId,
  lineup,
  isLineupConfirmed,
}: {
  gameId: string;
  awayTeamId: number;
  homeTeamId: number;
  lineup: GameLineup;
  isLineupConfirmed: boolean;
}) {
  const [analysis, setAnalysis] = useState<LineupAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchedGameId = useRef<string | null>(null);

  useEffect(() => {
    // 올스타전은 팀기반 AI 분석 대상이 아니므로 스킵(API 호출·렌더 안 함).
    if (isAllStarGame(awayTeamId, homeTeamId)) {
      setLoading(false);
      setAnalysis(null);
      return;
    }
    // 같은 gameId + 같은 라인업이면 재요청 방지
    const lineupKey = `${gameId}:${lineup.away.startingPitcher.name}:${lineup.home.startingPitcher.name}`;
    if (fetchedGameId.current === lineupKey) return;
    fetchedGameId.current = lineupKey;
    setLoading(true);
    setAnalysis(null);

    async function load() {
      try {
        const getRes = await fetch(`/api/lineup-analysis?gameId=${gameId}`);
        const getData = await getRes.json();
        if (getData.analysis) {
          setAnalysis(getData.analysis);
          setLoading(false);
          return;
        }

        const catcher = (side: typeof lineup.away) =>
          side.batters.find(b => b.position === "C")?.name || "";

        const postRes = await fetch("/api/lineup-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            gameId,
            awayTeamId,
            homeTeamId,
            isLineupConfirmed,
            lineup: {
              away: {
                startingPitcher: lineup.away.startingPitcher.name,
                startingPitcherEra: lineup.away.startingPitcher.era,
                catcher: catcher(lineup.away),
                batters: lineup.away.batters.map(b => ({
                  order: b.order,
                  position: b.position,
                  name: b.name,
                })),
              },
              home: {
                startingPitcher: lineup.home.startingPitcher.name,
                startingPitcherEra: lineup.home.startingPitcher.era,
                catcher: catcher(lineup.home),
                batters: lineup.home.batters.map(b => ({
                  order: b.order,
                  position: b.position,
                  name: b.name,
                })),
              },
            },
          }),
        });
        const postData = await postRes.json();
        if (postData.analysis) {
          setAnalysis(postData.analysis);
        }
      } catch {
        // silently fail
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [gameId, awayTeamId, homeTeamId, lineup, isLineupConfirmed]);

  if (!loading && !analysis) return null;

  return (
    <div className="glass-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-base">🤖</span>
        <span className="text-sm font-semibold text-text-primary">AI 라인업 분석</span>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-3">
          <div className="w-5 h-5 border-2 border-text-tertiary border-t-text-primary rounded-full animate-spin" />
          <span className="ml-2 text-sm text-text-tertiary">분석 생성 중...</span>
        </div>
      ) : analysis ? (
        <div className="space-y-2.5">
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-sm">⚾</span>
              <span className="text-xs font-medium text-text-secondary">투수·포수</span>
            </div>
            <p className="text-sm text-text-primary leading-relaxed">{analysis.battery}</p>
          </div>
          <div className="border-t border-border/50" />
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-sm">📋</span>
              <span className="text-xs font-medium text-text-secondary">타순 변경</span>
            </div>
            <p className="text-sm text-text-primary leading-relaxed">{analysis.lineup}</p>
          </div>
          {analysis.rotation && (
            <>
              <div className="border-t border-border/50" />
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-sm">🔄</span>
                  <span className="text-xs font-medium text-text-secondary">로테이션</span>
                </div>
                <p className="text-sm text-text-primary leading-relaxed">{analysis.rotation}</p>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function LineupTab({
  lineup,
  awayTeam,
  homeTeam,
  gameId,
  isLineupConfirmed,
}: LineupTabProps) {
  const awaySp = lineup.away.startingPitcher.name;
  const homeSp = lineup.home.startingPitcher.name;
  // batters가 비어있으면 라인업 미확정 (KBO LINEUP_CK=false fallback 차단)
  const hasBatters = lineup.away.batters.length > 0 && lineup.home.batters.length > 0;
  const isLineupPartial = !awaySp || !homeSp || !hasBatters;

  // 올스타전: 게임 팀이 나눔/드림이라 선수의 원소속 팀 정보가 lineup에 없음 →
  // 확정 엔트리(allstar-2026)로 이름 → 원소속 teamId/kboId 해석해 팀명 병기 +
  // 아바타/프로필 링크 보정 (하린아빠 2026-07-11 예외처리 지시).
  const isAllStar = isAllStarGame(awayTeam.id, homeTeam.id);
  const allStarInfo = (name: string) => {
    if (!isAllStar) return undefined;
    const entry = findAllStarEntryByName(name);
    if (!entry) return undefined;
    const team = getTeamById(entry.teamId);
    return team ? { teamId: entry.teamId, kboId: entry.kboId, shortName: team.shortName, color: team.colorLight } : undefined;
  };
  const awaySpInfo = allStarInfo(awaySp);
  const homeSpInfo = allStarInfo(homeSp);

  return (
    <div className="px-4 py-4 space-y-5 overflow-y-auto">
      {/* Lineup not fully confirmed notice */}
      {isLineupPartial && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
          <span className="text-yellow-400 text-sm">⚠️</span>
          <span className="text-sm text-yellow-400/90">
            {!awaySp || !homeSp
              ? "선발투수 정보가 아직 반영되지 않았습니다. 경기 시작 전 업데이트됩니다."
              : "타순은 라인업 확정 후 공개됩니다."}
          </span>
        </div>
      )}

      {/* Starting pitchers */}
      <div className="flex items-start justify-around">
        <PitcherCard
          name={lineup.away.startingPitcher.name}
          era={lineup.away.startingPitcher.era}
          teamColor={awayTeam.colorPrimary}
          teamId={awaySpInfo?.teamId ?? awayTeam.id}
          kboId={lineup.away.startingPitcher.kboId ?? awaySpInfo?.kboId}
          label={awayTeam.shortName}
          subLabel={awaySpInfo ? { text: awaySpInfo.shortName, color: awaySpInfo.color } : undefined}
        />
        <div className="text-text-tertiary text-base mt-8">VS</div>
        <PitcherCard
          name={lineup.home.startingPitcher.name}
          era={lineup.home.startingPitcher.era}
          teamColor={homeTeam.colorPrimary}
          teamId={homeSpInfo?.teamId ?? homeTeam.id}
          kboId={lineup.home.startingPitcher.kboId ?? homeSpInfo?.kboId}
          label={homeTeam.shortName}
          subLabel={homeSpInfo ? { text: homeSpInfo.shortName, color: homeSpInfo.color } : undefined}
        />
      </div>

      {/* AI Lineup Analysis — 라인업 확정 + 정규전(올스타 제외) 시에만 표시 */}
      {!isLineupPartial && isLineupConfirmed && !isAllStarGame(awayTeam.id, homeTeam.id) && (
        <AiLineupAnalysisCard
          gameId={gameId}
          awayTeamId={awayTeam.id}
          homeTeamId={homeTeam.id}
          lineup={lineup}
          isLineupConfirmed={isLineupConfirmed}
        />
      )}

      {/* Lineup table */}
      <div className="glass-card p-5 overflow-hidden">
        <table className="w-full text-base">
          <thead>
            <tr className="text-text-tertiary border-b border-border">
              <th className="py-2 text-left font-medium w-6">#</th>
              <th className="py-2 text-left font-medium">
                <span style={{ color: awayTeam.colorLight }}>
                  {awayTeam.shortName}
                </span>
              </th>
              <th className="py-2 w-4" />
              <th className="py-2 text-right font-medium">
                <span style={{ color: homeTeam.colorLight }}>
                  {homeTeam.shortName}
                </span>
              </th>
              <th className="py-2 text-right font-medium w-6">#</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 9 }, (_, i) => {
              const away = lineup.away.batters[i];
              const home = lineup.home.batters[i];
              // 방어: 9명 미만 라인업(비정상 데이터)에서 undefined 접근 크래시 방지.
              if (!away || !home) return null;
              const awayInfo = allStarInfo(away.name);
              const homeInfo = allStarInfo(home.name);
              const awayHref = resolvePlayerHref(awayInfo ? { ...away, ...awayInfo } : away);
              const homeHref = resolvePlayerHref(homeInfo ? { ...home, ...homeInfo } : home);
              return (
                <tr
                  key={i}
                  className={clsx(
                    "border-b border-border/50",
                    i % 2 === 0 && "bg-bg-glass/30"
                  )}
                >
                  <td className="py-2 text-text-tertiary tabular-nums">
                    {away.order}
                  </td>
                  <td className="py-2">
                    <Link href={awayHref} prefetch={false} className="flex items-center gap-1.5 hover:opacity-80">
                      <PlayerAvatar
                        name={away.name}
                        teamId={awayInfo?.teamId ?? away.teamId}
                        photoUrl={getPlayerPhotoUrl(away.name, away.kboId ?? awayInfo?.kboId, awayInfo?.teamId ?? awayTeam.id)}
                        size={36}
                        showTeamBadge={false}
                      />
                      <span className="text-xs text-text-tertiary w-6 text-center shrink-0">
                        {away.position}
                      </span>
                      <div className="flex flex-col">
                        <span className="text-sm text-text-primary font-medium whitespace-nowrap">
                          {away.name}
                          {awayInfo && (
                            <span className="ml-1 text-[10px] font-semibold align-middle" style={{ color: awayInfo.color }}>
                              {awayInfo.shortName}
                            </span>
                          )}
                        </span>
                        {away.avg && away.avg !== "-" && (
                          <span className="text-xs text-text-secondary tabular-nums leading-tight">
                            {formatAvg(away.avg)}
                          </span>
                        )}
                      </div>
                    </Link>
                  </td>
                  <td className="py-2 text-center">
                    <div className="w-px h-4 bg-border mx-auto" />
                  </td>
                  <td className="py-2 text-right">
                    <Link href={homeHref} prefetch={false} className="flex items-center justify-end gap-1.5 hover:opacity-80">
                      <div className="flex flex-col items-end">
                        <span className="text-sm text-text-primary font-medium whitespace-nowrap">
                          {homeInfo && (
                            <span className="mr-1 text-[10px] font-semibold align-middle" style={{ color: homeInfo.color }}>
                              {homeInfo.shortName}
                            </span>
                          )}
                          {home.name}
                        </span>
                        {home.avg && home.avg !== "-" && (
                          <span className="text-xs text-text-secondary tabular-nums leading-tight">
                            {formatAvg(home.avg)}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-text-tertiary w-6 text-center shrink-0">
                        {home.position}
                      </span>
                      <PlayerAvatar
                        name={home.name}
                        teamId={homeInfo?.teamId ?? home.teamId}
                        photoUrl={getPlayerPhotoUrl(home.name, home.kboId ?? homeInfo?.kboId, homeInfo?.teamId ?? homeTeam.id)}
                        size={36}
                        showTeamBadge={false}
                      />
                    </Link>
                  </td>
                  <td className="py-2 text-right text-text-tertiary tabular-nums">
                    {home.order}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
