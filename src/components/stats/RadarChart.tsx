"use client";

import { ResponsiveRadar } from "@nivo/radar";
import type { PlayerSeasonStats } from "@/lib/types";
import { LEAGUE_AVG_BATTER, LEAGUE_AVG_PITCHER } from "@/lib/constants/players";

interface RadarChartProps {
  stats: PlayerSeasonStats;
  teamColor: string;
  isPitcher: boolean;
}

function toBatterPercentile(stats: PlayerSeasonStats) {
  const avg = LEAGUE_AVG_BATTER;
  return [
    { stat: "타율", player: Math.min(((stats.avg ?? 0) / avg.avg) * 100, 150), league: 100 },
    { stat: "OPS", player: Math.min(((stats.ops ?? 0) / avg.ops) * 100, 150), league: 100 },
    { stat: "HR", player: Math.min(((stats.hr ?? 0) / avg.hr) * 100, 150), league: 100 },
    { stat: "타점", player: Math.min(((stats.rbi ?? 0) / avg.rbi) * 100, 150), league: 100 },
    { stat: "도루", player: Math.min(((stats.sb ?? 0) / avg.sb) * 100, 150), league: 100 },
  ];
}

function toPitcherPercentile(stats: PlayerSeasonStats) {
  const avg = LEAGUE_AVG_PITCHER;
  return [
    { stat: "ERA", player: Math.min((avg.era / (stats.era ?? avg.era)) * 100, 150), league: 100 },
    { stat: "WHIP", player: Math.min((avg.whip / (stats.whip ?? avg.whip)) * 100, 150), league: 100 },
    { stat: "K/9", player: Math.min(((stats.kPer9 ?? 0) / avg.kPer9) * 100, 150), league: 100 },
    { stat: "승", player: Math.min(((stats.wins ?? 0) / avg.wins) * 100, 150), league: 100 },
    { stat: "이닝", player: Math.min(((stats.ip ?? 0) / avg.ip) * 100, 150), league: 100 },
  ];
}

export default function RadarChart({ stats, teamColor, isPitcher }: RadarChartProps) {
  const data = isPitcher ? toPitcherPercentile(stats) : toBatterPercentile(stats);

  return (
    <div className="h-[260px] w-full">
      <ResponsiveRadar
        data={data}
        keys={["player", "league"]}
        indexBy="stat"
        maxValue={150}
        margin={{ top: 32, right: 48, bottom: 32, left: 48 }}
        borderWidth={2}
        borderColor={teamColor}
        gridLevels={4}
        gridShape="circular"
        gridLabelOffset={16}
        dotSize={8}
        dotColor={teamColor}
        dotBorderWidth={2}
        dotBorderColor={teamColor}
        colors={[teamColor, "rgba(255,255,255,0.15)"]}
        fillOpacity={0.25}
        blendMode="normal"
        animate={true}
        motionConfig="gentle"
        theme={{
          text: { fill: "#8E8E93", fontSize: 11 },
          grid: { line: { stroke: "rgba(255,255,255,0.08)" } },
          tooltip: {
            container: {
              background: "#1C1C1F",
              color: "#F5F5F7",
              borderRadius: "8px",
              border: "1px solid rgba(255,255,255,0.08)",
              fontSize: 12,
            },
          },
        }}
        sliceTooltip={({ index, data: sliceData }) => (
          <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-xs">
            <p className="font-semibold text-text-primary">{index}</p>
            {sliceData.map((d) => (
              <p key={d.id} style={{ color: d.id === "player" ? teamColor : "#8E8E93" }}>
                {d.id === "player" ? "선수" : "리그 평균"}: {Math.round(d.value)}%
              </p>
            ))}
          </div>
        )}
      />
    </div>
  );
}
