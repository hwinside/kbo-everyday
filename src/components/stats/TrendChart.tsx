"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
} from "recharts";
import type { PlayerGameLog, PitcherGameLog } from "@/lib/constants/players";

interface TrendChartProps {
  data: PlayerGameLog[] | PitcherGameLog[];
  teamColor: string;
  isPitcher: boolean;
}

export default function TrendChart({ data, teamColor, isPitcher }: TrendChartProps) {
  if (isPitcher) {
    const pitcherData = data as PitcherGameLog[];
    return (
      <div className="h-[200px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={pitcherData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="eraGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={teamColor} stopOpacity={0.3} />
                <stop offset="95%" stopColor={teamColor} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="date"
              tick={{ fill: "#8E8E93", fontSize: 10 }}
              axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: "#8E8E93", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              domain={["auto", "auto"]}
              reversed
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#1C1C1F",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 8,
                fontSize: 12,
                color: "#F5F5F7",
              }}
              formatter={(value) => [Number(value).toFixed(2), "ERA"]}
            />
            <Area
              type="monotone"
              dataKey="era"
              stroke={teamColor}
              strokeWidth={2.5}
              fill="url(#eraGrad)"
              dot={{ fill: teamColor, r: 3, strokeWidth: 0 }}
              activeDot={{ r: 5, fill: teamColor }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  const batterData = data as PlayerGameLog[];
  return (
    <div className="h-[200px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={batterData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="avgGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={teamColor} stopOpacity={0.3} />
              <stop offset="95%" stopColor={teamColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
          <XAxis
            dataKey="date"
            tick={{ fill: "#8E8E93", fontSize: 10 }}
            axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "#8E8E93", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => v.toFixed(3).slice(1)}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#1C1C1F",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 8,
              fontSize: 12,
              color: "#F5F5F7",
            }}
            formatter={(value, name) => [
              Number(value).toFixed(3),
              name === "avg" ? "타율" : "OPS",
            ]}
          />
          <Area
            type="monotone"
            dataKey="avg"
            stroke={teamColor}
            strokeWidth={2.5}
            fill="url(#avgGrad)"
            dot={{ fill: teamColor, r: 3, strokeWidth: 0 }}
            activeDot={{ r: 5, fill: teamColor }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
