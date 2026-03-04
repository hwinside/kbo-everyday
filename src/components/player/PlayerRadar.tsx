"use client";

import { useState, useEffect } from "react";
import RadarChart from "./RadarChart";

interface PlayerRadarProps {
  playerId: string;
  position: string;
  teamColor?: string;
}

function calcBatterRadar(s: any) {
  // 6각형: 타격, 파워, 선구안, 주루, 안정감, 출루
  const avg = parseFloat(s.avg) || 0;
  const obp = parseFloat(s.obp) || 0;
  const slg = parseFloat(s.slg) || 0;
  const games = s.games || 1;
  const pa = s.pa || 1;
  const bb = s.bb || 0;
  const so = s.so || 0;
  const sb = s.sb || 0;
  const hr = s.hr || 0;

  // 0~100 스케일 (KBO 평균 기준 정규화)
  const hitting = Math.min(100, Math.round((avg / 0.320) * 100));     // .320 = 엘리트
  const power = Math.min(100, Math.round((slg / 0.550) * 100));       // .550 = 엘리트
  const eye = Math.min(100, Math.round(((bb / pa) / 0.12) * 100));    // 12% BB% = 엘리트
  const speed = Math.min(100, Math.round((sb / 30) * 100));            // 30 SB = 엘리트
  const consistency = Math.min(100, Math.round((1 - (so / pa) / 0.25) * 100)); // 삼진율 낮을수록 좋음
  const onbase = Math.min(100, Math.round((obp / 0.420) * 100));      // .420 = 엘리트

  return [
    { label: "타격", value: hitting },
    { label: "파워", value: power },
    { label: "선구안", value: eye },
    { label: "주루", value: speed },
    { label: "안정감", value: consistency },
    { label: "출루", value: onbase },
  ];
}

function calcPitcherRadar(s: any) {
  // 6각형: 제구, 구위, 탈삼진, 체력, 안정감, 지배력
  const era = parseFloat(s.era) || 5;
  const whip = parseFloat(s.whip) || 1.5;
  const games = s.games || 1;
  const ip = parseFloat(s.ip) || 1;
  const so = s.so || 0;
  const bb = s.bb || 0;
  const hr = s.hr || 0;

  const control = Math.min(100, Math.round((1 - (bb / ip) / 0.5) * 100));     // BB/IP 낮을수록 좋음
  const stuff = Math.min(100, Math.round((so / ip / 1.2) * 100));              // K/IP 높을수록 좋음  
  const strikeout = Math.min(100, Math.round((so / Math.max(ip, 1)) / 1.0 * 100)); // K/9 기준
  const stamina = Math.min(100, Math.round((ip / 180) * 100));                 // 180이닝 = 풀타임
  const consistency = Math.min(100, Math.round((1 - era / 6.0) * 100));        // ERA 낮을수록 좋음
  const dominance = Math.min(100, Math.round((1 - whip / 1.8) * 100));         // WHIP 낮을수록 좋음

  return [
    { label: "제구", value: Math.max(0, control) },
    { label: "구위", value: Math.max(0, stuff) },
    { label: "탈삼진", value: Math.max(0, strikeout) },
    { label: "체력", value: Math.max(0, stamina) },
    { label: "안정감", value: Math.max(0, consistency) },
    { label: "지배력", value: Math.max(0, dominance) },
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
          const radar = isPitcher ? calcPitcherRadar(d.stats) : calcBatterRadar(d.stats);
          setStats(radar);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [playerId, position, isPitcher]);

  if (loading) return <div className="flex justify-center py-4"><div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" /></div>;
  if (!stats) return null;

  // 평균 계산
  const avg = Math.round(stats.reduce((s, v) => s + v.value, 0) / stats.length);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="text-center">
        <span className="text-xs text-gray-400">종합 능력치</span>
        <span className="ml-2 text-lg font-bold" style={{ color: teamColor }}>{avg}</span>
      </div>
      <RadarChart stats={stats} size={220} teamColor={teamColor} />
    </div>
  );
}
