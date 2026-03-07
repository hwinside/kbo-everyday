"use client";

import type { LineupPlayer } from "@/lib/constants/games";

interface FieldViewProps {
  defenders: LineupPlayer[];
  currentPitcher: string | null;
  currentBatter: string | null;
  runner1b: boolean;
  runner2b: boolean;
  runner3b: boolean;
}

// Position abbreviation to field coordinate mapping
const POSITION_COORDS: Record<string, { top?: string; bottom?: string; left?: string; right?: string; transform?: string }> = {
  P:  { bottom: "100px", left: "50%", transform: "translateX(-50%)" },
  C:  { bottom: "4px", left: "50%", transform: "translateX(-50%)" },
  "1B": { bottom: "88px", right: "40px" },
  "2B": { bottom: "135px", right: "80px" },
  SS: { bottom: "135px", left: "80px" },
  "3B": { bottom: "88px", left: "40px" },
  LF: { top: "20px", left: "50px" },
  CF: { top: "4px", left: "50%", transform: "translateX(-50%)" },
  RF: { top: "20px", right: "50px" },
};

function PlayerMarker({
  label,
  name,
  type,
  style,
}: {
  label: string;
  name: string;
  type: "defense" | "pitcher" | "runner" | "batter";
  style: React.CSSProperties;
}) {
  const dotStyles: Record<string, string> = {
    defense: "border-blue-400 text-blue-400",
    pitcher: "border-red-500 text-red-500 bg-red-500/10",
    runner: "border-yellow-400 text-yellow-400 bg-yellow-400/10",
    batter: "border-sky-400 text-sky-400 bg-sky-400/10",
  };

  const nameStyles: Record<string, string> = {
    defense: "text-text-tertiary",
    pitcher: "text-white font-semibold",
    runner: "text-yellow-400",
    batter: "text-sky-400",
  };

  return (
    <div className="absolute flex flex-col items-center gap-0.5 z-10" style={style}>
      <div
        className={`w-7 h-7 rounded-full bg-bg-tertiary border-2 flex items-center justify-center text-[9px] font-bold ${dotStyles[type]}`}
      >
        {label}
      </div>
      <span
        className={`text-[9px] whitespace-nowrap ${nameStyles[type]}`}
        style={{ textShadow: "0 1px 3px #000, 0 0 6px #000" }}
      >
        {name}
      </span>
    </div>
  );
}

export default function FieldView({
  defenders,
  currentPitcher,
  currentBatter,
  runner1b,
  runner2b,
  runner3b,
}: FieldViewProps) {
  // Map defenders to their positions
  // The pitcher from defenders list is replaced by currentPitcher if available
  const getDefenderByPosition = (pos: string) => {
    return defenders.find((d) => d.position === pos);
  };

  return (
    <div className="relative w-full h-[240px] overflow-hidden rounded-lg">
      {/* Outfield grass */}
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-[320px] h-[180px] rounded-t-[50%]"
        style={{
          background: "radial-gradient(ellipse at 50% 130%, #1a3d1a 0%, #0d2a0d 60%, transparent 80%)",
        }}
      />

      {/* Infield diamond */}
      <div
        className="absolute bottom-5 left-1/2 -translate-x-1/2 rotate-45 w-[100px] h-[100px] rounded-sm border border-[#3a2f24]"
        style={{ background: "#2a1f14" }}
      />

      {/* Bases */}
      <div
        className={`absolute w-2.5 h-2.5 rotate-45 rounded-[1px] bottom-[82px] right-[calc(50%-55px)] ${
          runner1b ? "bg-yellow-400 shadow-[0_0_6px_#ffd60088]" : "bg-[#555]"
        }`}
      />
      <div
        className={`absolute w-2.5 h-2.5 rotate-45 rounded-[1px] bottom-[138px] left-1/2 -translate-x-1/2 ${
          runner2b ? "bg-yellow-400 shadow-[0_0_6px_#ffd60088]" : "bg-[#555]"
        }`}
      />
      <div
        className={`absolute w-2.5 h-2.5 rotate-45 rounded-[1px] bottom-[82px] left-[calc(50%-55px)] ${
          runner3b ? "bg-yellow-400 shadow-[0_0_6px_#ffd60088]" : "bg-[#555]"
        }`}
      />
      {/* Home plate */}
      <div className="absolute w-2.5 h-2.5 rotate-45 rounded-[1px] bottom-7 left-1/2 -translate-x-1/2 bg-[#555]" />

      {/* Defensive players */}
      {Object.entries(POSITION_COORDS).map(([pos, coords]) => {
        if (pos === "P") {
          // Use currentPitcher name
          return currentPitcher ? (
            <PlayerMarker
              key={pos}
              label="P"
              name={currentPitcher}
              type="pitcher"
              style={coords}
            />
          ) : null;
        }
        const defender = getDefenderByPosition(pos);
        if (!defender) return null;
        return (
          <PlayerMarker
            key={pos}
            label={pos}
            name={defender.name}
            type="defense"
            style={coords}
          />
        );
      })}

      {/* Runners */}
      {runner1b && (
        <PlayerMarker
          label="R"
          name=""
          type="runner"
          style={{ bottom: "78px", right: "calc(50% - 65px)" }}
        />
      )}
      {runner2b && (
        <PlayerMarker
          label="R"
          name=""
          type="runner"
          style={{ bottom: "142px", left: "50%", transform: "translateX(-50%)" }}
        />
      )}

      {/* Batter */}
      {currentBatter && (
        <PlayerMarker
          label="AB"
          name={currentBatter}
          type="batter"
          style={{ bottom: "14px", left: "calc(50% + 18px)" }}
        />
      )}
    </div>
  );
}
