"use client";

import Image from "next/image";
import Link from "next/link";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import batterStatsJson from "@/lib/constants/stats-2025-batters.json";
import pitcherStatsJson from "@/lib/constants/stats-2025-pitchers.json";
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
  const photoUrl = getPlayerPhotoUrl(name);
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

  // Relay matchup → BoxScore → static JSON fallback
  const relayPitcher = relayMatchup?.pitcher;
  const relayBatter = relayMatchup?.batter;

  // Use relay data to build pitcherToday/batterToday if BoxScore is empty
  const effectivePitcherToday: PitcherTodayStats | null | undefined = pitcherToday ?? (relayPitcher ? {
    pitchCount: relayPitcher.pitchCount,
    strikeouts: relayPitcher.strikeouts,
    walks: relayPitcher.walks,
    hits: relayPitcher.hits,
    earnedRuns: relayPitcher.earnedRuns,
    era: relayPitcher.seasonEra > 0 ? relayPitcher.seasonEra.toFixed(2) : "",
  } : null);

  const effectiveBatterToday: BatterTodayStats | null | undefined = batterToday ?? (relayBatter ? {
    atBats: relayBatter.ab,
    hits: relayBatter.hits,
    runs: relayBatter.run,
    rbi: relayBatter.rbi,
    avg: relayBatter.seasonAvg > 0 ? `.${Math.round(relayBatter.seasonAvg * 1000)}` : ".000",
  } : null);

  const resolvedEra = pitcherEra ?? (relayPitcher && relayPitcher.seasonEra > 0 ? relayPitcher.seasonEra.toFixed(2) : null) ?? (currentPitcher ? lookupPitcherEra(currentPitcher) : null);
  const resolvedAvg = batterAvg ?? (relayBatter && relayBatter.seasonAvg > 0 ? `.${Math.round(relayBatter.seasonAvg * 1000)}` : null) ?? (currentBatter ? lookupBatterAvg(currentBatter) : null);

  return (
    <div className="flex justify-between items-center px-3.5 py-2.5 mx-3 mb-2.5 bg-bg-tertiary rounded-[10px]">
      {/* Pitcher side */}
      {currentPitcher && (
        <div className="flex items-center gap-2.5">
          <PlayerPhoto name={currentPitcher} type="pitcher" />
          <div className="min-h-[48px] flex flex-col justify-center">
            <div className="text-[11px] text-text-secondary font-semibold">투수</div>
            {(() => {
              const href = getPlayerHref(currentPitcher);
              return href ? (
                <Link href={href} className="text-[15px] font-bold hover:underline" style={{ color: "var(--matchup-name)" }}>{currentPitcher}</Link>
              ) : (
                <div className="text-[15px] font-bold" style={{ color: "var(--matchup-name)" }}>{currentPitcher}</div>
              );
            })()}
            <div className="mt-0.5 leading-relaxed">
              {effectivePitcherToday ? (
                <>
                  <div className="flex gap-1.5 text-xs">
                    <span className="text-text-secondary font-semibold">{effectivePitcherToday.pitchCount}구</span>
                    <span className="text-[#e53935]">K <b>{effectivePitcherToday.strikeouts}</b></span>
                    <span className="text-[#64b5f6]">BB <b>{effectivePitcherToday.walks}</b></span>
                  </div>
                  <div className="flex gap-1.5 text-xs">
                    <span className="text-[#ff7043]">H <b>{effectivePitcherToday.hits}</b></span>
                    <span className="text-[#ffc107]">ER <b>{effectivePitcherToday.earnedRuns}</b></span>
                    {resolvedEra && (
                      <span className="text-text-secondary">ERA {resolvedEra}</span>
                    )}
                  </div>
                </>
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

      {/* VS */}
      <div className="text-xs font-semibold" style={{ color: "var(--matchup-vs)" }}>VS</div>

      {/* Batter side */}
      {currentBatter && (
        <div className="flex items-center gap-2.5">
          <div className="text-right min-h-[48px] flex flex-col justify-center">
            <div className="text-[11px] text-text-secondary font-semibold">타자</div>
            {(() => {
              const href = getPlayerHref(currentBatter);
              return href ? (
                <Link href={href} className="text-[15px] font-bold hover:underline" style={{ color: "var(--matchup-name)" }}>{currentBatter}</Link>
              ) : (
                <div className="text-[15px] font-bold" style={{ color: "var(--matchup-name)" }}>{currentBatter}</div>
              );
            })()}
            <div className="mt-0.5 leading-relaxed">
              {effectiveBatterToday ? (
                <>
                  <div className="flex gap-1.5 text-xs justify-end">
                    {resolvedAvg && (
                      <span className="text-[#4fc3f7] font-semibold">{resolvedAvg}</span>
                    )}
                    <span className="text-text-secondary">{effectiveBatterToday.atBats}타수</span>
                    <span className="text-[#4caf50]">{effectiveBatterToday.hits}안타</span>
                  </div>
                  <div className="flex gap-1.5 text-xs justify-end">
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
  );
}
