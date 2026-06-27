"use client";

import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import type { PlayerGameLog, PitcherGameLog } from "@/lib/constants/players";

/**
 * 홈 최애선수 카드용 미니 스파크라인 (축/그리드/툴팁 없는 압축 추이).
 * 투수는 ERA(낮을수록 좋음)라 Y축 reversed로 선수 상세 차트와 시각 방향 일치.
 */
export default function MiniTrendSparkline({
  data,
  teamColor,
  isPitcher,
}: {
  data: (PlayerGameLog | PitcherGameLog)[];
  teamColor: string;
  isPitcher: boolean;
}) {
  const dataKey = isPitcher ? "era" : "avg";
  const gradId = `mini-${isPitcher ? "era" : "avg"}-${teamColor.replace("#", "")}`;
  return (
    <div className="h-[34px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 3, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={teamColor} stopOpacity={0.28} />
              <stop offset="95%" stopColor={teamColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={["auto", "auto"]} reversed={isPitcher} />
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={teamColor}
            strokeWidth={2}
            fill={`url(#${gradId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
