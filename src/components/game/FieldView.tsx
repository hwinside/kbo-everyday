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

/*
  Base coordinates (anchor points for positioning):
  Home plate:  bottom 28px, center
  1st base:    bottom 82px, ~55px right of center
  2nd base:    bottom 138px, center
  3rd base:    bottom 82px, ~55px left of center
  Mound:       ~bottom 78px, center (between home & 2nd)

  Players use left: calc(50% ± offset) with translateX(-50%) for centering.
  내야수는 다이아몬드 라인 위에 걸치도록, 외야수는 잔디 안쪽에.
*/
const POSITION_COORDS: Record<string, React.CSSProperties> = {
  // 투수: 마운드 = 다이아몬드 정중앙
  P:    { bottom: "78px", left: "50%", transform: "translateX(-50%)" },
  // 포수: 홈 플레이트 뒤
  C:    { bottom: "8px", left: "50%", transform: "translateX(-50%)" },
  // 1루수: 1루 베이스 근처, 약간 바깥
  "1B": { bottom: "72px", left: "calc(50% + 62px)", transform: "translateX(-50%)" },
  // 2루수: 1-2루 사이, 다이아몬드 라인 위
  "2B": { bottom: "115px", left: "calc(50% + 32px)", transform: "translateX(-50%)" },
  // 유격수: 2-3루 사이, 다이아몬드 라인 위
  SS:   { bottom: "115px", left: "calc(50% - 32px)", transform: "translateX(-50%)" },
  // 3루수: 3루 베이스 근처, 약간 바깥
  "3B": { bottom: "72px", left: "calc(50% - 62px)", transform: "translateX(-50%)" },
  // 좌익수: 잔디 안쪽
  LF:   { top: "30px", left: "calc(50% - 95px)", transform: "translateX(-50%)" },
  // 중견수: 잔디 중앙
  CF:   { top: "12px", left: "50%", transform: "translateX(-50%)" },
  // 우익수: 잔디 안쪽
  RF:   { top: "30px", left: "calc(50% + 95px)", transform: "translateX(-50%)" },
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
  const getDefenderByPosition = (pos: string) => {
    return defenders.find((d) => d.position === pos);
  };

  return (
    <div className="relative w-full h-[240px] overflow-hidden rounded-lg">
      {/* Outfield grass — wider to contain outfielders */}
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-[380px] h-[190px] rounded-t-[50%]"
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
        className={`absolute w-2.5 h-2.5 rotate-45 rounded-[1px] bottom-[82px] left-[calc(50%+50px)] -translate-x-1/2 ${
          runner1b ? "bg-yellow-400 shadow-[0_0_6px_#ffd60088]" : "bg-[#555]"
        }`}
      />
      <div
        className={`absolute w-2.5 h-2.5 rotate-45 rounded-[1px] bottom-[138px] left-1/2 -translate-x-1/2 ${
          runner2b ? "bg-yellow-400 shadow-[0_0_6px_#ffd60088]" : "bg-[#555]"
        }`}
      />
      <div
        className={`absolute w-2.5 h-2.5 rotate-45 rounded-[1px] bottom-[82px] left-[calc(50%-50px)] -translate-x-1/2 ${
          runner3b ? "bg-yellow-400 shadow-[0_0_6px_#ffd60088]" : "bg-[#555]"
        }`}
      />
      {/* Home plate */}
      <div className="absolute w-2.5 h-2.5 rotate-45 rounded-[1px] bottom-7 left-1/2 -translate-x-1/2 bg-[#555]" />

      {/* Defensive players */}
      {Object.entries(POSITION_COORDS).map(([pos, coords]) => {
        if (pos === "P") {
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

      {/* Runners — positioned near their bases */}
      {runner1b && (
        <PlayerMarker
          label="R"
          name=""
          type="runner"
          style={{ bottom: "90px", left: "calc(50% + 60px)", transform: "translateX(-50%)" }}
        />
      )}
      {runner2b && (
        <PlayerMarker
          label="R"
          name=""
          type="runner"
          style={{ bottom: "145px", left: "50%", transform: "translateX(-50%)" }}
        />
      )}
      {runner3b && (
        <PlayerMarker
          label="R"
          name=""
          type="runner"
          style={{ bottom: "90px", left: "calc(50% - 60px)", transform: "translateX(-50%)" }}
        />
      )}

      {/* Batter — next to home plate */}
      {currentBatter && (
        <PlayerMarker
          label="AB"
          name={currentBatter}
          type="batter"
          style={{ bottom: "14px", left: "calc(50% + 22px)", transform: "translateX(-50%)" }}
        />
      )}
    </div>
  );
}
