"use client";

import { useState, useEffect } from "react";
import RadarChart from "./RadarChart";

interface PlayerRadarProps {
  playerId: string;
  position: string;
  teamColor?: string;
}

function calcBatterRadar(s: any) {
  const avg = parseFloat(s.avg) || 0;
  const obp = parseFloat(s.obp) || 0;
  const slg = parseFloat(s.slg) || 0;
  const pa = s.pa || 1;
  const bb = s.bb || 0;
  const so = s.so || 0;
  const sb = s.sb || 0;

  return [
    { label: "타격", value: Math.min(100, Math.round((avg / 0.320) * 100)) },
    { label: "파워", value: Math.min(100, Math.round((slg / 0.550) * 100)) },
    { label: "선구안", value: Math.min(100, Math.round(((bb / pa) / 0.12) * 100)) },
    { label: "주루", value: Math.min(100, Math.round((sb / 30) * 100)) },
    { label: "안정감", value: Math.min(100, Math.round((1 - (so / pa) / 0.25) * 100)) },
    { label: "출루", value: Math.min(100, Math.round((obp / 0.420) * 100)) },
  ];
}

function calcPitcherRadar(s: any) {
  const era = parseFloat(s.era) || 5;
  const whip = parseFloat(s.whip) || 1.5;
  const ip = parseFloat(s.ip) || 1;
  const so = s.so || 0;
  const bb = s.bb || 0;

  return [
    { label: "제구", value: Math.max(0, Math.min(100, Math.round((1 - (bb / ip) / 0.5) * 100))) },
    { label: "구위", value: Math.max(0, Math.min(100, Math.round((so / ip / 1.2) * 100))) },
    { label: "탈삼진", value: Math.max(0, Math.min(100, Math.round((so / Math.max(ip, 1)) / 1.0 * 100))) },
    { label: "체력", value: Math.max(0, Math.min(100, Math.round((ip / 180) * 100))) },
    { label: "안정감", value: Math.max(0, Math.min(100, Math.round((1 - era / 6.0) * 100))) },
    { label: "지배력", value: Math.max(0, Math.min(100, Math.round((1 - whip / 1.8) * 100))) },
  ];
}

export default function PlayerRadar({ playerId, position, teamColor }: PlayerRadarProps) {
  const [stats, setStats] = useState<{ label: string; value: number }[] | null>(null);
  const [loading, setLoading] = useState(true);
  const isPitcher = position === "투수" || position?.includes("투");

  useEffect(() => {
    fetch(`/api/player-stats?id=${playerId}&pos=${encodeURIComponent(position)}`)
      .then(r => r.json())
      .then(d => {
        if (d.stats) {
          setStats(isPitcher ? calcPitcherRadar(d.stats) : calcBatterRadar(d.stats));
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [playerId, position, isPitcher]);

  if (loading) return <div className="flex justify-center py-4"><div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" /></div>;
  if (!stats) return null;

  return (
    <div className="flex flex-col items-center gap-1">
      <RadarChart stats={stats} size={220} teamColor={teamColor} />
      <p className="text-[11px] text-gray-500">점선 = 리그 평균 기준</p>
    </div>
  );
}
