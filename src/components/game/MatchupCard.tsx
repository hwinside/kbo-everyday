"use client";

import Image from "next/image";
import Link from "next/link";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import batterStatsJson from "@/lib/constants/stats-2025-batters.json";
import pitcherStatsJson from "@/lib/constants/stats-2025-pitchers.json";
import playersRoster from "@/lib/constants/players-roster.json";
import { getTeamById } from "@/lib/constants/teams";

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
}: MatchupCardProps) {
  if (!currentPitcher && !currentBatter) return null;

  const resolvedEra = pitcherEra ?? (currentPitcher ? lookupPitcherEra(currentPitcher) : null);
  const resolvedAvg = batterAvg ?? (currentBatter ? lookupBatterAvg(currentBatter) : null);

  return (
    <div className="flex justify-between items-center px-3.5 py-2.5 mx-3 mb-2.5 bg-bg-tertiary rounded-[10px]">
      {/* Pitcher side */}
      {currentPitcher && (
        <div className="flex items-center gap-2">
          <PlayerPhoto name={currentPitcher} type="pitcher" />
          <div>
            <div className="text-[10px] text-text-tertiary">투수</div>
            {(() => {
              const href = getPlayerHref(currentPitcher);
              return href ? (
                <Link href={href} className="text-sm font-bold text-white hover:underline">{currentPitcher}</Link>
              ) : (
                <div className="text-sm font-bold text-white">{currentPitcher}</div>
              );
            })()}
            <div className="mt-0.5 leading-relaxed">
              {pitcherToday ? (
                <>
                  <div className="flex gap-1.5 text-[11px]">
                    <span className="text-text-secondary font-semibold">{pitcherToday.pitchCount}구</span>
                    <span className="text-[#e53935]">K <b>{pitcherToday.strikeouts}</b></span>
                    <span className="text-[#64b5f6]">BB <b>{pitcherToday.walks}</b></span>
                  </div>
                  <div className="flex gap-1.5 text-[11px]">
                    <span className="text-[#ff7043]">H <b>{pitcherToday.hits}</b></span>
                    <span className="text-[#ffc107]">ER <b>{pitcherToday.earnedRuns}</b></span>
                    {resolvedEra && (
                      <span className="text-text-tertiary">ERA {resolvedEra}</span>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex gap-1.5 text-[11px]">
                  {resolvedEra && (
                    <span className="text-text-tertiary">ERA {resolvedEra}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* VS */}
      <div className="text-[11px] text-[#555] font-semibold">VS</div>

      {/* Batter side */}
      {currentBatter && (
        <div className="flex items-center gap-2">
          <div className="text-right">
            <div className="text-[10px] text-text-tertiary">타자</div>
            {(() => {
              const href = getPlayerHref(currentBatter);
              return href ? (
                <Link href={href} className="text-sm font-bold text-white hover:underline">{currentBatter}</Link>
              ) : (
                <div className="text-sm font-bold text-white">{currentBatter}</div>
              );
            })()}
            <div className="mt-0.5 leading-relaxed">
              {batterToday ? (
                <>
                  <div className="flex gap-1.5 text-[11px] justify-end">
                    {resolvedAvg && (
                      <span className="text-[#4fc3f7] font-semibold">{resolvedAvg}</span>
                    )}
                    <span className="text-text-secondary">{batterToday.atBats}타수</span>
                    <span className="text-[#4caf50]">{batterToday.hits}안타</span>
                  </div>
                  <div className="flex gap-1.5 text-[11px] justify-end">
                    <span className="text-[#ffd600]">{batterToday.runs}득점</span>
                    <span className="text-[#ff7043]">{batterToday.rbi}타점</span>
                  </div>
                </>
              ) : (
                <div className="flex gap-1.5 text-[11px] justify-end">
                  {resolvedAvg && (
                    <span className="text-[#4fc3f7] font-semibold">{resolvedAvg}</span>
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
