"use client";

import Image from "next/image";
import Link from "next/link";
import type { LineupPlayer } from "@/lib/constants/games";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { resolveRosterPlayer } from "@/lib/utils/player-roster";


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
  currentPitcherTeamId?: number;
  currentBatterTeamId?: number;
  runnerTeamId?: number;
  onDeckBatters?: { order: number; name: string }[];
  batterBats?: "L" | "R" | "S" | null; // 좌타/우타/스위치
  balls?: number;
  strikes?: number;
  outs?: number;
}

type MarkerType = "defense" | "pitcher" | "runner" | "batter";

const BORDER_COLORS: Record<MarkerType, string> = {
  defense: "var(--field-defense)",
  pitcher: "#7ecb4a",
  runner: "#ffd600",
  batter: "#7ecb4a",
};

function PlayerMarker({
  name,
  type,
  label,
  posLabel,
  className,
  teamId,
  kboId,
}: {
  name: string;
  type: MarkerType;
  label?: string;
  posLabel?: string; // 포지션명 (CF, 2B 등)
  className: string;
  teamId?: number;
  kboId?: string;
}) {
  const borderColor = BORDER_COLORS[type];
  const isHighlight = type === "pitcher" || type === "runner" || type === "batter";
  const nameColor =
    type === "runner" ? "var(--field-runner-text)" : type === "batter" ? "var(--field-highlight-text)" : type === "pitcher" ? "var(--field-highlight-text)" : "var(--field-label-text)";

  // Player link/photo lookup must not fall back to name-only for 동명이인.
  // 마커 역할로 같은 팀 동명이인(투/야)을 분리: 투수 마커(P 포함)는 투수,
  // 야수 수비/타석/주자 마커는 야수 힌트. (수비 마커의 P 는 posLabel 로 구분)
  const positionHint =
    type === "pitcher" || posLabel === "P" ? ("투수" as const) : ("야수" as const);
  const rosterPlayer = resolveRosterPlayer({ name, kboId, teamId, positionHint });
  const playerHref = rosterPlayer ? `/community/players/${rosterPlayer.kboId}` : null;
  const photoUrl = getPlayerPhotoUrl(name, rosterPlayer?.kboId, teamId, positionHint);

  const content = (
    <>
      <div
        className="w-7 h-7 rounded-full overflow-hidden flex items-center justify-center bg-bg-tertiary"
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
          textShadow: "var(--field-label-shadow)",
          background: "var(--field-label-bg)",
        }}
      >
        {name}
      </span>
    </>
  );

  return (
    <div className={`absolute flex flex-col items-center gap-0 z-10 ${className}`}>
      {playerHref ? (
        <Link href={playerHref} prefetch={false} className="flex flex-col items-center gap-0">
          {content}
        </Link>
      ) : (
        content
      )}
      {/* 포지션명 (수비수만, 주자/타자 제외) */}
      {posLabel && (
        <span
          className="text-[7px] whitespace-nowrap px-[2px] rounded-[2px] -mt-px"
          style={{
            color: "var(--field-pos-text)",
            textShadow: "var(--field-label-shadow)",
            background: "var(--field-pos-bg)",
          }}
        >
          {posLabel}
        </span>
      )}
    </div>
  );
}

// Position classes matching v8.8 mockup — 컴팩트 버전
const POS_CLASSES: Record<string, string> = {
  P: "bottom-[27%] left-1/2 -translate-x-1/2",
  C: "bottom-[4%] left-1/2 -translate-x-1/2",
  "1B": "bottom-[33%] right-[10%]",
  "2B": "bottom-[43%] right-[26%]",
  SS: "bottom-[43%] left-[26%]",
  "3B": "bottom-[33%] left-[10%]",
  LF: "top-[6%] left-[12%]",
  CF: "top-[2%] left-1/2 -translate-x-1/2",
  RF: "top-[6%] right-[12%]",
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
  currentPitcherTeamId,
  currentBatterTeamId,
  runnerTeamId,
  onDeckBatters,
  batterBats,
  balls = 0,
  strikes = 0,
  outs = 0,
}: FieldViewV2Props) {
  const getDefender = (pos: string) => defenders.find((d) => d.position === pos);

  const positions = ["LF", "CF", "RF", "SS", "2B", "3B", "1B", "C"] as const;

  // 좌타자 = 오른쪽(1루쪽), 우타자 = 왼쪽(3루쪽)
  const batterClass =
    batterBats === "R"
      ? "bottom-[8%] right-[calc(50%-24px)]" // 우타석 (3루쪽)
      : "bottom-[8%] left-[calc(50%+24px)]"; // 좌타석 (1루쪽, default)

  return (
    <div className="mx-3 mb-2 bg-bg-tertiary rounded-xl p-2 overflow-hidden">
      <div
        className="relative w-full overflow-hidden rounded-lg max-w-[480px] mx-auto"
        style={{ aspectRatio: "1 / 0.55" }}
      >
        {/* Outfield grass — light/dark variants */}
        <div
          className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[110%] h-[90%] rounded-t-[50%] dark:hidden"
          style={{
            background:
              "radial-gradient(ellipse at 50% 100%, #3a7a3a 0%, #2d6a2d 25%, #1f5a1f 45%, var(--bg-tertiary) 65%)",
          }}
        />
        <div
          className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[110%] h-[90%] rounded-t-[50%] hidden dark:block"
          style={{
            background:
              "radial-gradient(ellipse at 50% 100%, #1b4a1b 0%, #143814 25%, #0d2a0d 45%, #12121e 65%)",
          }}
        />

        {/* Infield diamond — clip-path polygon */}
        <div
          className="absolute"
          style={{
            left: "18%",
            right: "18%",
            bottom: "8%",
            top: "38%",
            background: "var(--field-infield)",
            clipPath: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
          }}
        />

        {/* Fielders with position labels */}
        {positions.map((pos) => {
          const defender = getDefender(pos);
          if (!defender) return null;
          return (
            <PlayerMarker
              key={pos}
              name={defender.name}
              type="defense"
              label={pos}
              posLabel={pos}
              className={POS_CLASSES[pos]}
              teamId={defender.teamId}
              kboId={defender.kboId}
            />
          );
        })}

        {/* Pitcher */}
        {currentPitcher && (
          <PlayerMarker
            name={currentPitcher}
            type="pitcher"
            label="P"
            posLabel="P"
            className={POS_CLASSES.P}
            teamId={currentPitcherTeamId}
          />
        )}

        {/* Runners — 이름이 없어도 베이스 점유 자체는 표시 */}
        {runner1b && (
          <PlayerMarker
            name={runner1bName || "주자"}
            type="runner"
            label="R"
            className="bottom-[26%] right-[20%]"
            teamId={runnerTeamId}
          />
        )}
        {runner2b && (
          <PlayerMarker
            name={runner2bName || "주자"}
            type="runner"
            label="R"
            className="bottom-[58%] left-1/2 -translate-x-1/2"
            teamId={runnerTeamId}
          />
        )}
        {runner3b && (
          <PlayerMarker
            name={runner3bName || "주자"}
            type="runner"
            label="R"
            className="bottom-[26%] left-[20%]"
            teamId={runnerTeamId}
          />
        )}

        {/* Batter — 좌타/우타에 따라 위치 변경 */}
        {currentBatter && (
          <PlayerMarker
            name={currentBatter}
            type="batter"
            label="AB"
            className={batterClass}
            teamId={currentBatterTeamId}
          />
        )}

        {/* BSO Scoreboard overlay — bottom right */}
        <div className="absolute -bottom-1 -right-1 z-[15] rounded-md px-2 py-1.5 backdrop-blur-sm" style={{ background: "var(--field-bso-bg)", border: "1px solid var(--field-bso-border)" }}>
          <div className="flex flex-col gap-0.5">
            {/* Balls */}
            <div className="flex items-center gap-1">
              <span className="text-[8px] font-bold text-[#4caf50] w-[8px]">B</span>
              <div className="flex gap-[2px]">
                {[0, 1, 2, 3].map((i) => (
                  <span
                    key={`b-${i}`}
                    className={`inline-block w-[7px] h-[7px] rounded-full ${
                      i < balls ? "bg-[#4caf50]" : ""
                    }`}
                    style={i >= balls ? { backgroundColor: "var(--field-bso-inactive)" } : undefined}
                  />
                ))}
              </div>
            </div>
            {/* Strikes */}
            <div className="flex items-center gap-1">
              <span className="text-[8px] font-bold text-[#ffc107] w-[8px]">S</span>
              <div className="flex gap-[2px]">
                {[0, 1, 2].map((i) => (
                  <span
                    key={`s-${i}`}
                    className={`inline-block w-[7px] h-[7px] rounded-full ${
                      i < strikes ? "bg-[#ffc107]" : ""
                    }`}
                    style={i >= strikes ? { backgroundColor: "var(--field-bso-inactive)" } : undefined}
                  />
                ))}
              </div>
            </div>
            {/* Outs */}
            <div className="flex items-center gap-1">
              <span className="text-[8px] font-bold text-[#e53935] w-[8px]">O</span>
              <div className="flex gap-[2px]">
                {[0, 1].map((i) => (
                  <span
                    key={`o-${i}`}
                    className={`inline-block w-[7px] h-[7px] rounded-full ${
                      i < outs ? "bg-[#e53935]" : ""
                    }`}
                    style={i >= outs ? { backgroundColor: "var(--field-bso-inactive)" } : undefined}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* On-deck batters overlay */}
        {onDeckBatters && onDeckBatters.length > 0 && (
          <div className="absolute bottom-[5%] left-2 z-[15] rounded-md px-1.5 py-1" style={{ background: "var(--field-ondeck-bg)" }}>
            <div className="text-[7px] font-semibold mb-0.5" style={{ color: "var(--field-pos-text)" }}>대기타석</div>
            {onDeckBatters.map((b) => (
              <div
                key={b.order}
                className="text-[8px] leading-relaxed"
                style={{ color: "var(--field-ondeck-text)", textShadow: "var(--field-label-shadow)" }}
              >
                <span className="font-semibold mr-0.5" style={{ color: "var(--field-pos-text)" }}>{b.order}.</span>
                {b.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
