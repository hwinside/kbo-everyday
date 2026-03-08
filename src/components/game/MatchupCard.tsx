"use client";

import Image from "next/image";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import batterStatsJson from "@/lib/constants/stats-2025-batters.json";
import pitcherStatsJson from "@/lib/constants/stats-2025-pitchers.json";

interface MatchupCardProps {
  currentPitcher: string | null;
  currentBatter: string | null;
  pitcherEra?: string;
  batterAvg?: string;
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
  const borderColor = type === "pitcher" ? "#e53935" : "#4fc3f7";

  return (
    <div
      className="w-[38px] h-[38px] rounded-full overflow-hidden flex items-center justify-center bg-[#2a2a3e] flex-shrink-0"
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
        <span className="text-[10px] text-[#666]">{name.charAt(0)}</span>
      )}
    </div>
  );
}

export default function MatchupCard({
  currentPitcher,
  currentBatter,
  pitcherEra,
  batterAvg,
}: MatchupCardProps) {
  if (!currentPitcher && !currentBatter) return null;

  const resolvedEra = pitcherEra ?? (currentPitcher ? lookupPitcherEra(currentPitcher) : null);
  const resolvedAvg = batterAvg ?? (currentBatter ? lookupBatterAvg(currentBatter) : null);

  return (
    <div className="flex justify-between items-center px-3.5 py-2.5 mx-3 mb-2.5 bg-[#12121e] rounded-[10px]">
      {/* Pitcher side */}
      {currentPitcher && (
        <div className="flex items-center gap-2">
          <PlayerPhoto name={currentPitcher} type="pitcher" />
          <div>
            <div className="text-[10px] text-[#888]">투수</div>
            <div className="text-sm font-bold text-white">{currentPitcher}</div>
            <div className="mt-0.5 leading-relaxed">
              <div className="flex gap-1.5 text-[11px]">
                <span className="text-[#ccc] font-semibold">72구</span>
                <span className="text-[#4caf50]">B <b>40</b></span>
                <span className="text-[#ffc107]">S <b>32</b></span>
              </div>
              <div className="flex gap-1.5 text-[11px]">
                <span className="text-[#e53935]">K <b>6</b></span>
                <span className="text-[#64b5f6]">BB <b>3</b></span>
                {resolvedEra && (
                  <span className="text-[#888]">ERA {resolvedEra}</span>
                )}
              </div>
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
            <div className="text-[10px] text-[#888]">타자</div>
            <div className="text-sm font-bold text-white">{currentBatter}</div>
            <div className="mt-0.5 leading-relaxed">
              <div className="flex gap-1.5 text-[11px] justify-end">
                {resolvedAvg && (
                  <span className="text-[#4fc3f7] font-semibold">{resolvedAvg}</span>
                )}
                <span className="text-[#ccc]">2타수</span>
                <span className="text-[#4caf50]">1안타</span>
                <span className="text-[#ffd600]">1득점</span>
              </div>
              <div className="flex gap-1.5 text-[11px] justify-end">
                <span className="text-[#ff7043]">1홈런</span>
                <span className="text-[#64b5f6]">1볼넷</span>
              </div>
            </div>
          </div>
          <PlayerPhoto name={currentBatter} type="batter" />
        </div>
      )}
    </div>
  );
}
