"use client";
import Link from "next/link";
import { useState, useEffect, useRef } from "react";

import { clsx } from "clsx";
import { type TeamData } from "@/lib/constants/teams";
import type { GameLineup } from "@/lib/constants/games";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import playersRoster from "@/lib/constants/players-roster.json";

// 선수 kboId 해살 (SSOT: /community/players/[kboId] 단일 라우트)
// 라인업 데이터에 kboId가 없어도 roster에서 name→kboId 매핑으로 kboId 확보.
// 정 안 되면(신규 외국인 등 드물 상황) name fallback 유지.
function resolvePlayerHref(batter: { name: string; kboId?: string; teamId?: number }): string {
  if (batter.kboId) return `/community/players/${batter.kboId}`;
  const rosterHit = (playersRoster as { name: string; kboId: string; teamId: number }[]).find(
    (p) => p.name === batter.name && (batter.teamId == null || p.teamId === batter.teamId)
  );
  if (rosterHit) return `/community/players/${rosterHit.kboId}`;
  return `/community/players/${encodeURIComponent(batter.name)}`;
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
}: {
  name: string;
  era: string;
  teamColor: string;
  teamId: number;
  kboId?: string;
  label: string;
}) {
  return (
    <div className="text-center flex flex-col items-center">
      <div className="text-base text-text-tertiary mb-2">{label}</div>
      <PlayerAvatar
        name={name}
        teamId={teamId}
        photoUrl={getPlayerPhotoUrl(name, kboId)}
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
      <div className="text-sm text-text-secondary mt-1 tabular-nums">
        ERA {era}
      </div>
    </div>
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
  }, [gameId, awayTeamId, homeTeamId, lineup]);

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

  return (
    <div className="px-4 py-4 space-y-5 overflow-y-auto">
      {/* Lineup not fully confirmed notice */}
      {isLineupPartial && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
          <span className="text-yellow-400 text-sm">⚠️</span>
          <span className="text-sm text-yellow-400/90">
            선발투수 정보가 아직 반영되지 않았습니다. 경기 시작 전 업데이트됩니다.
          </span>
        </div>
      )}

      {/* Starting pitchers */}
      <div className="flex items-start justify-around">
        <PitcherCard
          name={lineup.away.startingPitcher.name}
          era={lineup.away.startingPitcher.era}
          teamColor={awayTeam.colorPrimary}
          teamId={awayTeam.id}
          kboId={lineup.away.startingPitcher.kboId}
          label={awayTeam.shortName}
        />
        <div className="text-text-tertiary text-base mt-8">VS</div>
        <PitcherCard
          name={lineup.home.startingPitcher.name}
          era={lineup.home.startingPitcher.era}
          teamColor={homeTeam.colorPrimary}
          teamId={homeTeam.id}
          kboId={lineup.home.startingPitcher.kboId}
          label={homeTeam.shortName}
        />
      </div>

      {/* AI Lineup Analysis — 라인업 확정 시에만 표시 */}
      {!isLineupPartial && isLineupConfirmed && (
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
              const awayHref = resolvePlayerHref(away);
              const homeHref = resolvePlayerHref(home);
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
                    <Link href={awayHref} className="flex items-center gap-1.5 hover:opacity-80">
                      <PlayerAvatar
                        name={away.name}
                        teamId={away.teamId}
                        photoUrl={getPlayerPhotoUrl(away.name, away.kboId)}
                        size={36}
                        showTeamBadge={false}
                      />
                      <span className="text-xs text-text-tertiary w-6 text-center shrink-0">
                        {away.position}
                      </span>
                      <div className="flex flex-col">
                        <span className="text-sm text-text-primary font-medium whitespace-nowrap">
                          {away.name}
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
                    <Link href={homeHref} className="flex items-center justify-end gap-1.5 hover:opacity-80">
                      <div className="flex flex-col items-end">
                        <span className="text-sm text-text-primary font-medium whitespace-nowrap">
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
                        teamId={home.teamId}
                        photoUrl={getPlayerPhotoUrl(home.name, home.kboId)}
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
