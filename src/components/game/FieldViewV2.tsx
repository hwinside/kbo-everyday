"use client";

import Image from "next/image";
import type { LineupPlayer } from "@/lib/constants/games";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";

interface FieldViewV2Props {
  defenders: LineupPlayer[];
  currentPitcher: string | null;
  currentBatter: string | null;
  runner1b: boolean;
  runner2b: boolean;
  runner3b: boolean;
  runner1bName?: string | null;
  runner2bName?: string | null;
  runner3bName?: string | null;
  onDeckBatters?: { order: number; name: string }[];
}

type MarkerType = "defense" | "pitcher" | "runner" | "batter";

const BORDER_COLORS: Record<MarkerType, string> = {
  defense: "#6b8cce",
  pitcher: "#e53935",
  runner: "#ffd600",
  batter: "#4fc3f7",
};

function PlayerMarker({
  name,
  type,
  label,
  className,
}: {
  name: string;
  type: MarkerType;
  label?: string;
  className: string;
}) {
  const photoUrl = getPlayerPhotoUrl(name);
  const borderColor = BORDER_COLORS[type];
  const isHighlight = type === "pitcher" || type === "runner" || type === "batter";
  const nameColor =
    type === "runner" ? "#ffd600" : type === "batter" ? "#4fc3f7" : isHighlight ? "#fff" : "#bbb";

  return (
    <div className={`absolute flex flex-col items-center gap-0 z-10 ${className}`}>
      <div
        className="w-7 h-7 rounded-full overflow-hidden flex items-center justify-center bg-[#1a1a2e]"
        style={{ border: `2px solid ${borderColor}` }}
      >
        {photoUrl ? (
          <Image
            src={photoUrl}
            alt={name}
            width={28}
            height={28}
            unoptimized
            className="w-full h-full object-cover"
          />
        ) : (
          <span className="text-[8px] font-bold" style={{ color: borderColor }}>
            {label || name.charAt(0)}
          </span>
        )}
      </div>
      <span
        className="text-[8px] whitespace-nowrap -mt-px px-[3px] rounded-[3px]"
        style={{
          color: nameColor,
          fontWeight: isHighlight ? 600 : 400,
          textShadow: "0 1px 3px #000, 0 0 6px #000",
          background: "rgba(0,0,0,0.5)",
        }}
      >
        {name}
      </span>
    </div>
  );
}

// Position classes matching v8.8 mockup coordinates exactly
const POS_CLASSES: Record<string, string> = {
  P: "bottom-[30%] left-1/2 -translate-x-1/2",
  C: "bottom-[6%] left-1/2 -translate-x-1/2",
  "1B": "bottom-[33%] right-[8%]",
  "2B": "bottom-[43%] right-[25%]",
  SS: "bottom-[43%] left-[25%]",
  "3B": "bottom-[33%] left-[8%]",
  LF: "top-[8%] left-[10%]",
  CF: "top-[4%] left-1/2 -translate-x-1/2",
  RF: "top-[8%] right-[10%]",
};

export default function FieldViewV2({
  defenders,
  currentPitcher,
  currentBatter,
  runner1b,
  runner2b,
  runner3b,
  runner1bName,
  runner2bName,
  runner3bName,
  onDeckBatters,
}: FieldViewV2Props) {
  const getDefender = (pos: string) => defenders.find((d) => d.position === pos);

  const positions = ["LF", "CF", "RF", "SS", "2B", "3B", "1B", "C"] as const;

  return (
    <div className="mx-3 mb-2.5 bg-[#12121e] rounded-xl p-2.5 overflow-hidden">
      <div className="relative w-full overflow-hidden rounded-lg" style={{ aspectRatio: "1 / 0.7" }}>
        {/* Outfield grass */}
        <div
          className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[120%] h-[95%] rounded-t-[50%]"
          style={{
            background:
              "radial-gradient(ellipse at 50% 100%, #1b4a1b 0%, #143814 30%, #0d2a0d 50%, #12121e 70%)",
          }}
        />

        {/* Infield diamond */}
        <div
          className="absolute"
          style={{
            left: "16%",
            right: "16%",
            bottom: "8%",
            top: "35%",
            background: "#3a2a18",
            clipPath: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
          }}
        />

        {/* Fielders */}
        {positions.map((pos) => {
          const defender = getDefender(pos);
          if (!defender) return null;
          return (
            <PlayerMarker
              key={pos}
              name={defender.name}
              type="defense"
              label={pos}
              className={POS_CLASSES[pos]}
            />
          );
        })}

        {/* Pitcher */}
        {currentPitcher && (
          <PlayerMarker
            name={currentPitcher}
            type="pitcher"
            label="P"
            className={POS_CLASSES.P}
          />
        )}

        {/* Runners */}
        {runner1b && runner1bName && (
          <PlayerMarker
            name={runner1bName}
            type="runner"
            label="R"
            className="bottom-[26%] right-[18%]"
          />
        )}
        {runner2b && runner2bName && (
          <PlayerMarker
            name={runner2bName}
            type="runner"
            label="R"
            className="bottom-[56%] left-1/2 -translate-x-1/2"
          />
        )}
        {runner3b && runner3bName && (
          <PlayerMarker
            name={runner3bName}
            type="runner"
            label="R"
            className="bottom-[26%] left-[18%]"
          />
        )}

        {/* Batter */}
        {currentBatter && (
          <PlayerMarker
            name={currentBatter}
            type="batter"
            label="AB"
            className="bottom-[8%] left-[calc(50%+24px)]"
          />
        )}

        {/* On-deck batters overlay */}
        {onDeckBatters && onDeckBatters.length > 0 && (
          <div className="absolute bottom-[6%] left-2 z-[15]">
            <div className="text-[8px] text-[#888] font-semibold mb-0.5">대기타석</div>
            {onDeckBatters.map((b) => (
              <div key={b.order} className="text-[9px] text-white/75 leading-relaxed" style={{ textShadow: "0 1px 3px #000" }}>
                <span className="text-[#666] font-semibold mr-0.5">{b.order}.</span>
                {b.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
