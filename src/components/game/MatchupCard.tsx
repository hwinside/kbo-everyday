"use client";

import Image from "next/image";
import Link from "next/link";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import batterStatsJson from "@/lib/constants/stats-2026-batters.json";
import pitcherStatsJson from "@/lib/constants/stats-2026-pitchers.json";
import playersRoster from "@/lib/constants/players-roster.json";
import { getTeamById } from "@/lib/constants/teams";
import type { MatchupStats } from "@/app/api/game-relay/route";

function getPlayerHref(name: string): string | null {
  const player = (playersRoster as { name: string; kboId: string; teamId: number }[]).find(
    (p) => p.name === name
  );
  if (!player) return null;
  const team = getTeamById(player.teamId);
  if (!team) return null;
  return `/teams/${team.slug}/players/${player.kboId}`;
}

interface PitcherTodayStats {
  pitchCount: number;
  strikeouts: number;
  walks: number;
  hits: number;
  earnedRuns: number;
  era: string;
}

interface BatterTodayStats {
  atBats: number;
  hits: number;
  runs: number;
  rbi: number;
  avg: string;
}

interface MatchupCardProps {
  currentPitcher: string | null;
  currentBatter: string | null;
  pitcherEra?: string;
  batterAvg?: string;
  pitcherToday?: PitcherTodayStats | null;
  batterToday?: BatterTodayStats | null;
  relayMatchup?: MatchupStats;
}

function lookupBatterAvg(name: string): string | null {
  const found = (batterStatsJson as { name: string; avg: string }[]).find((b) => b.name === name);
  return found?.avg ?? null;
}

function lookupPitcherEra(name: string): string | null {
  const found = (pitcherStatsJson as { name: string; era: string }[]).find((p) => p.name === name);
  return found?.era ?? null;
}

function PlayerPhoto({ name, type }: { name: string; type: "pitcher" | "batter" }) {
  const rosterPlayer = (playersRoster as { name: string; kboId: string }[]).find(p => p.name === name);
  const photoUrl = getPlayerPhotoUrl(name, rosterPlayer?.kboId);
  const borderColor = "#7ecb4a";

  return (
    <div
      className="w-[38px] h-[38px] rounded-full overflow-hidden flex items-center justify-center bg-bg-tertiary flex-shrink-0"
      style={{ border: `2px solid ${borderColor}` }}
    >
      {photoUrl ? (
        <Image
          src={photoUrl}
          alt={name}
          width={38}
          height={38}
          unoptimized
          className="w-full h-full object-cover"
        />
      ) : (
        <span className="text-[10px] text-text-tertiary">{name.charAt(0)}</span>
      )}
    </div>
  );
}

export default function MatchupCard({
  currentPitcher,
  currentBatter,
  pitcherEra,
  batterAvg,
  pitcherToday,
  batterToday,
  relayMatchup,
}: MatchupCardProps) {
  if (!currentPitcher && !currentBatter) return null;

  // 라이브 매치업 카드는 relay를 우선 사용하고, 없을 때만 boxScore fallback
  const relayPitcher = relayMatchup?.pitcher;
  const relayBatter = relayMatchup?.batter;

  const effectivePitcherToday: PitcherTodayStats | null | undefined = relayPitcher ? {
    pitchCount: relayPitcher.pitchCount,
    strikeouts: relayPitcher.strikeouts,
    walks: relayPitcher.walks,
    hits: relayPitcher.hits,
    earnedRuns: relayPitcher.earnedRuns,
    era: relayPitcher.seasonEra > 0 ? relayPitcher.seasonEra.toFixed(2) : (pitcherToday?.era ?? ""),
  } : pitcherToday;

  // 투수 누적 B/S (relay에서 직접 가져옴)
  const pitcherBalls = relayPitcher?.ballCount ?? null;
  const pitcherStrikes = relayPitcher?.strikeCount ?? null;

  const effectiveBatterToday: BatterTodayStats | null | undefined = relayBatter ? {
    atBats: relayBatter.ab,
    hits: relayBatter.hits,
    runs: relayBatter.run,
    rbi: relayBatter.rbi,
    avg: relayBatter.seasonAvg > 0 ? `.${Math.round(relayBatter.seasonAvg * 1000)}` : (batterToday?.avg ?? ".000"),
  } : batterToday;

  const resolvedEra = pitcherEra ?? (relayPitcher && relayPitcher.seasonEra > 0 ? relayPitcher.seasonEra.toFixed(2) : null) ?? (currentPitcher ? lookupPitcherEra(currentPitcher) : null);
  const resolvedAvg = batterAvg ?? (relayBatter && relayBatter.seasonAvg > 0 ? `.${Math.round(relayBatter.seasonAvg * 1000)}` : null) ?? (currentBatter ? lookupBatterAvg(currentBatter) : null);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3.5 py-2.5 mx-3 mb-2.5 bg-bg-tertiary rounded-[10px]">
      {/* Pitcher side */}
      <div className="min-w-0">
        {currentPitcher && (
          <div className="flex items-center gap-2.5 min-w-0">
            <PlayerPhoto name={currentPitcher} type="pitcher" />
            <div className="min-h-[52px] min-w-0 flex flex-col justify-center">
              <div className="text-[11px] text-text-secondary font-semibold">투수</div>
              {(() => {
                const href = getPlayerHref(currentPitcher);
                return href ? (
                  <Link href={href} className="text-[15px] font-bold truncate hover:underline" style={{ color: "var(--matchup-name)" }}>{currentPitcher}</Link>
                ) : (
                  <div className="text-[15px] font-bold truncate" style={{ color: "var(--matchup-name)" }}>{currentPitcher}</div>
                );
              })()}
              <div className="mt-0.5 leading-relaxed">
                {effectivePitcherToday ? (
                  <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0 text-xs">
                    <div className="flex gap-1.5 whitespace-nowrap">
                      <span className="text-text-secondary font-semibold">{(pitcherBalls !== null && pitcherStrikes !== null) ? pitcherBalls + pitcherStrikes : effectivePitcherToday.pitchCount}구</span>
                      {pitcherBalls !== null && <span className="text-[#64b5f6]">B <b>{pitcherBalls}</b></span>}
                      {pitcherStrikes !== null && <span className="text-[#e53935]">S <b>{pitcherStrikes}</b></span>}
                    </div>
                    <div />
                    <div className="flex gap-1.5 whitespace-nowrap">
                      <span className="text-[#64b5f6]">BB <b>{effectivePitcherToday.walks}</b></span>
                      <span className="text-[#e53935]">K <b>{effectivePitcherToday.strikeouts}</b></span>
                    </div>
                    <div />
                  </div>
                ) : (
                  <div className="flex gap-1.5 text-xs">
                    {resolvedEra ? (
                      <span className="text-text-secondary">ERA {resolvedEra}</span>
                    ) : (
                      <span className="text-transparent select-none">&nbsp;</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* VS */}
      <div className="justify-self-center text-xs font-semibold" style={{ color: "var(--matchup-vs)" }}>VS</div>

      {/* Batter side */}
      <div className="min-w-0">
        {currentBatter && (
          <div className="flex items-center justify-end gap-2.5 min-w-0">
            <div className="text-right min-h-[52px] min-w-0 flex flex-col justify-center">
              <div className="text-[11px] text-text-secondary font-semibold">타자</div>
              {(() => {
                const href = getPlayerHref(currentBatter);
                return href ? (
                  <Link href={href} className="text-[15px] font-bold truncate hover:underline" style={{ color: "var(--matchup-name)" }}>{currentBatter}</Link>
                ) : (
                  <div className="text-[15px] font-bold truncate" style={{ color: "var(--matchup-name)" }}>{currentBatter}</div>
                );
              })()}
              <div className="mt-0.5 leading-relaxed">
                {effectiveBatterToday ? (
                  <>
                    <div className="flex gap-1.5 text-xs justify-end whitespace-nowrap">
                      {resolvedAvg && (
                        <span className="text-[#4fc3f7] font-semibold">{resolvedAvg}</span>
                      )}
                      <span className="text-text-secondary">{effectiveBatterToday.atBats}타수</span>
                      <span className="text-[#4caf50]">{effectiveBatterToday.hits}안타</span>
                    </div>
                    <div className="flex gap-1.5 text-xs justify-end whitespace-nowrap">
                      <span className="text-[#ffd600]">{effectiveBatterToday.runs}득점</span>
                      <span className="text-[#ff7043]">{effectiveBatterToday.rbi}타점</span>
                    </div>
                  </>
                ) : (
                  <div className="flex gap-1.5 text-xs justify-end">
                    {resolvedAvg ? (
                      <span className="text-[#4fc3f7] font-semibold">{resolvedAvg}</span>
                    ) : (
                      <span className="text-transparent select-none">&nbsp;</span>
                    )}
                  </div>
                )}
              </div>
            </div>
            <PlayerPhoto name={currentBatter} type="batter" />
          </div>
        )}
      </div>
    </div>
  );
}
