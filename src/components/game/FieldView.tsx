"use client";

import type { LineupPlayer } from "@/lib/constants/games";

interface FieldViewProps {
  defenders: LineupPlayer[];
  currentPitcher: string | null;
  currentBatter: string | null;
  runner1b: boolean;
  runner2b: boolean;
  runner3b: boolean;
  runner1bName?: string | null;
  runner2bName?: string | null;
  runner3bName?: string | null;
}

/*
  Diamond geometry — 플레이트가 각 모서리에
  110px square rotated 45° → diamond with ~78px half-diagonal
  
  Diamond center: bottom 130px, horizontally centered
  Home plate (bottom): bottom 52px
  1st base (right):    bottom 130px, +78px right
  2nd base (top):      bottom 208px
  3rd base (left):     bottom 130px, -78px left
  
  Pitcher mound: diamond center (bottom 130px)
  
  Fielders: 1B/3B slightly OUTSIDE their plates
  Runners:  1B/3B slightly INSIDE (toward basepath), 2B above plate
*/

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
    <div className="absolute flex flex-col items-center gap-0 z-10" style={style}>
      <div
        className={`w-6 h-6 rounded-full bg-bg-tertiary border-2 flex items-center justify-center text-[8px] font-bold ${dotStyles[type]}`}
      >
        {label}
      </div>
      <span
        className={`text-[8px] whitespace-nowrap leading-none ${nameStyles[type]}`}
        style={{ textShadow: "0 1px 3px #000, 0 0 6px #000" }}
      >
        {name}
      </span>
    </div>
  );
}

function BaseMarker({ active, style }: { active: boolean; style: React.CSSProperties }) {
  return (
    <div
      className={`absolute w-3 h-3 rotate-45 rounded-[1px] z-20 border ${
        active
          ? "bg-[#E53935] border-[#E53935] shadow-[0_0_8px_#E5393588]"
          : "bg-[#636366] border-[#48484A]"
      }`}
      style={style}
    />
  );
}

export default function FieldView({
  defenders,
  currentPitcher,
  currentBatter,
  runner1b,
  runner2b,
  runner3b,
  runner1bName,
  runner2bName,
  runner3bName,
}: FieldViewProps) {
  const getDefender = (pos: string) => defenders.find((d) => d.position === pos);

  // center helper: all positions relative to 50% center
  const cx = (offset: number) => `calc(50% + ${offset}px)`;

  return (
    <div className="relative w-full h-[280px] overflow-hidden rounded-lg">
      {/* Outfield grass */}
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[420px] h-[200px] rounded-t-[50%]"
        style={{
          background: "radial-gradient(ellipse at 50% 140%, #1a3d1a 0%, #0d2a0d 55%, transparent 78%)",
        }}
      />

      {/* Infield diamond (110px square → 45° → diamond ~156px diagonal) */}
      <div
        className="absolute border border-border rounded-sm"
        style={{
          width: "110px",
          height: "110px",
          bottom: "75px", // center at 130px (75 + 55)
          left: "50%",
          transform: "translateX(-50%) rotate(45deg)",
          background: "#2a1f14",
        }}
      />

      {/* Base plates at each diamond corner */}
      <BaseMarker active={false} style={{ bottom: "49px", left: "50%", transform: "translateX(-50%) rotate(45deg)" }} />
      <BaseMarker active={runner1b} style={{ bottom: "127px", left: cx(75), transform: "translateX(-50%) rotate(45deg)" }} />
      <BaseMarker active={runner2b} style={{ bottom: "205px", left: "50%", transform: "translateX(-50%) rotate(45deg)" }} />
      <BaseMarker active={runner3b} style={{ bottom: "127px", left: cx(-75), transform: "translateX(-50%) rotate(45deg)" }} />

      {/* ===== OUTFIELDERS (잔디 안쪽) ===== */}
      {(() => { const p = getDefender("LF"); return p ? <PlayerMarker label="LF" name={p.name} type="defense" style={{ top: "22px", left: cx(-95), transform: "translateX(-50%)" }} /> : null; })()}
      {(() => { const p = getDefender("CF"); return p ? <PlayerMarker label="CF" name={p.name} type="defense" style={{ top: "6px", left: "50%", transform: "translateX(-50%)" }} /> : null; })()}
      {(() => { const p = getDefender("RF"); return p ? <PlayerMarker label="RF" name={p.name} type="defense" style={{ top: "22px", left: cx(95), transform: "translateX(-50%)" }} /> : null; })()}

      {/* ===== INFIELDERS ===== */}
      {/* 2B — 2루 방향, 1루쪽 */}
      {(() => { const p = getDefender("2B"); return p ? <PlayerMarker label="2B" name={p.name} type="defense" style={{ bottom: "178px", left: cx(32), transform: "translateX(-50%)" }} /> : null; })()}
      {/* SS — 2루 방향, 3루쪽 */}
      {(() => { const p = getDefender("SS"); return p ? <PlayerMarker label="SS" name={p.name} type="defense" style={{ bottom: "178px", left: cx(-32), transform: "translateX(-50%)" }} /> : null; })()}
      {/* 1B — 1루 플레이트 위 (바깥쪽, 파울라인 방향) */}
      {(() => { const p = getDefender("1B"); return p ? <PlayerMarker label="1B" name={p.name} type="defense" style={{ bottom: "140px", left: cx(85), transform: "translateX(-50%)" }} /> : null; })()}
      {/* 3B — 3루 플레이트 위 (바깥쪽, 파울라인 방향) */}
      {(() => { const p = getDefender("3B"); return p ? <PlayerMarker label="3B" name={p.name} type="defense" style={{ bottom: "140px", left: cx(-85), transform: "translateX(-50%)" }} /> : null; })()}

      {/* ===== PITCHER (다이아몬드 정중앙) ===== */}
      {currentPitcher && (
        <PlayerMarker label="P" name={currentPitcher} type="pitcher" style={{ bottom: "125px", left: "50%", transform: "translateX(-50%)" }} />
      )}

      {/* ===== CATCHER (홈플레이트 아래) ===== */}
      {(() => { const p = getDefender("C"); return p ? <PlayerMarker label="C" name={p.name} type="defense" style={{ bottom: "14px", left: "50%", transform: "translateX(-50%)" }} /> : null; })()}

      {/* ===== RUNNERS (플레이트 안쪽/밑, 이름 표시) ===== */}
      {/* 1루 주자: 1루 플레이트 밑 (홈 방향) */}
      {runner1b && (
        <PlayerMarker label="R" name={runner1bName || ""} type="runner" style={{ bottom: "108px", left: cx(68), transform: "translateX(-50%)" }} />
      )}
      {/* 2루 주자: 2루 플레이트 위 (외야 방향) */}
      {runner2b && (
        <PlayerMarker label="R" name={runner2bName || ""} type="runner" style={{ bottom: "214px", left: "50%", transform: "translateX(-50%)" }} />
      )}
      {/* 3루 주자: 3루 플레이트 밑 (홈 방향) */}
      {runner3b && (
        <PlayerMarker label="R" name={runner3bName || ""} type="runner" style={{ bottom: "108px", left: cx(-68), transform: "translateX(-50%)" }} />
      )}

      {/* ===== BATTER (홈플레이트 옆) ===== */}
      {currentBatter && (
        <PlayerMarker label="AB" name={currentBatter} type="batter" style={{ bottom: "42px", left: cx(24), transform: "translateX(-50%)" }} />
      )}
    </div>
  );
}
