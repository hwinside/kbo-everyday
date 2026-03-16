"use client";

import { motion } from "framer-motion";
import { clsx } from "clsx";
import PlayerAvatar from "@/components/ui/PlayerAvatar";

interface PitcherStats {
  era: string;
  pitchCount?: number;
}

interface BatterStats {
  avg: string;
  todayRecord?: string;
}

interface CountIndicatorProps {
  balls: number;
  strikes: number;
  outs: number;
  currentBatter: string | null;
  currentPitcher: string | null;
  pitcherPhotoUrl?: string | null;
  batterPhotoUrl?: string | null;
  pitcherTeamId?: number;
  batterTeamId?: number;
  pitcherStats?: PitcherStats;
  batterStats?: BatterStats;
}

function CountDots({
  label,
  count,
  max,
  activeColor,
}: {
  label: string;
  count: number;
  max: number;
  activeColor: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-base font-bold text-text-tertiary w-3">{label}</span>
      <div className="flex gap-0.5">
        {Array.from({ length: max }, (_, i) => (
          <motion.div
            key={i}
            className={clsx("w-2.5 h-2.5 rounded-full")}
            style={{
              backgroundColor: i < count ? activeColor : "var(--field-bso-inactive)",
            }}
            animate={
              i === count - 1 && count > 0
                ? { scale: [1, 1.3, 1] }
                : { scale: 1 }
            }
            transition={{ duration: 0.3 }}
          />
        ))}
      </div>
    </div>
  );
}

export default function CountIndicator({
  balls,
  strikes,
  outs,
  currentBatter,
  currentPitcher,
  pitcherPhotoUrl,
  batterPhotoUrl,
  pitcherTeamId,
  batterTeamId,
  pitcherStats,
  batterStats,
}: CountIndicatorProps) {
  const hasEnhancedStats = pitcherStats || batterStats;

  return (
    <div className="space-y-3">
      {/* BSO counts */}
      <div className="flex items-center gap-4">
        <CountDots label="B" count={balls} max={4} activeColor="#30D158" />
        <CountDots label="S" count={strikes} max={3} activeColor="#FFD60A" />
        <CountDots label="O" count={outs} max={3} activeColor="#FF453A" />
      </div>

      {/* Enhanced matchup with photos and stats */}
      {hasEnhancedStats && (currentBatter || currentPitcher) ? (
        <div className="flex items-center justify-between pt-2 border-t border-border">
          {/* Pitcher */}
          {currentPitcher && (
            <div className="flex items-center gap-2">
              <div className="ring-2 ring-red-500/50 rounded-full">
                <PlayerAvatar
                  name={currentPitcher}
                  teamId={pitcherTeamId}
                  photoUrl={pitcherPhotoUrl}
                  size={36}
                  showTeamBadge={false}
                />
              </div>
              <div>
                <div className="text-[10px] text-text-tertiary uppercase tracking-wider">투수</div>
                <div className="text-sm font-bold text-text-primary">{currentPitcher}</div>
                {pitcherStats && (
                  <>
                    <div className="text-[11px] text-accent font-medium">
                      ERA {pitcherStats.era}
                    </div>
                    {pitcherStats.pitchCount !== undefined && (
                      <div className="text-[11px] text-yellow-400 font-semibold">
                        {pitcherStats.pitchCount}구
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          <span className="text-xs text-text-tertiary font-semibold">VS</span>

          {/* Batter */}
          {currentBatter && (
            <div className="flex items-center gap-2">
              <div className="text-right">
                <div className="text-[10px] text-text-tertiary uppercase tracking-wider">타자</div>
                <div className="text-sm font-bold text-text-primary">{currentBatter}</div>
                {batterStats && (
                  <>
                    <div className="text-[11px] text-accent font-medium">
                      {batterStats.avg}
                    </div>
                    {batterStats.todayRecord && (
                      <div className="text-[11px] text-text-secondary">
                        {batterStats.todayRecord}
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="ring-2 ring-sky-400/50 rounded-full">
                <PlayerAvatar
                  name={currentBatter}
                  teamId={batterTeamId}
                  photoUrl={batterPhotoUrl}
                  size={36}
                  showTeamBadge={false}
                />
              </div>
            </div>
          )}
        </div>
      ) : (currentBatter || currentPitcher) ? (
        <div className="flex items-center justify-end gap-4 text-base whitespace-nowrap">
          {currentPitcher && (
            <span className="text-text-tertiary">
              <span className="text-text-secondary">P</span> {currentPitcher}
            </span>
          )}
          {currentBatter && (
            <span className="text-text-primary font-medium">
              <span className="text-text-secondary">AB</span> {currentBatter}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
