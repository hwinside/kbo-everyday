"use client";

import type { LineupPlayer } from "@/lib/constants/games";

interface OnDeckBattersProps {
  batters: LineupPlayer[];
  currentBatterName: string | null;
}

export default function OnDeckBatters({ batters, currentBatterName }: OnDeckBattersProps) {
  if (!currentBatterName || batters.length === 0) return null;

  const currentIndex = batters.findIndex((b) => b.name === currentBatterName);
  if (currentIndex === -1) return null;

  // Get next 3 batters (wrap around)
  const nextBatters: LineupPlayer[] = [];
  for (let i = 1; i <= 3; i++) {
    const idx = (currentIndex + i) % batters.length;
    nextBatters.push(batters[idx]);
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2 mx-4 mb-3 bg-bg-secondary rounded-lg">
      <span className="text-[10px] text-text-tertiary font-semibold whitespace-nowrap">
        다음 타석
      </span>
      <div className="flex items-center gap-3 overflow-x-auto">
        {nextBatters.map((batter) => (
          <div key={batter.order} className="flex items-center gap-1 whitespace-nowrap">
            <span className="text-[10px] text-text-tertiary font-semibold min-w-[14px]">
              {batter.order}
            </span>
            <span className="text-xs text-text-secondary">{batter.name}</span>
            <span className="text-[10px] text-text-tertiary">{batter.avg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
