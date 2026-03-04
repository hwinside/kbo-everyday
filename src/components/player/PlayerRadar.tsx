"use client";

import { useState, useEffect } from "react";
import RadarChart from "./RadarChart";
import { getBatterTraits, getPitcherTraits } from "@/lib/utils/player-traits";

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

const BATTER_INFO = [
  { label: "타격", desc: "타율 기반 (리그 평균 ~.270)" },
  { label: "파워", desc: "장타율 기반 (높을수록 장타력)" },
  { label: "선구안", desc: "볼넷 비율 (사구 많을수록 높음)" },
  { label: "주루", desc: "도루 성공 횟수 기반" },
  { label: "안정감", desc: "삼진 비율 역수 (삼진 적을수록 높음)" },
  { label: "출루", desc: "출루율 기반 (안타+볼넷+사구)" },
];

const PITCHER_INFO = [
  { label: "제구", desc: "이닝당 볼넷 역수 (볼넷 적을수록 높음)" },
  { label: "구위", desc: "이닝당 탈삼진 비율" },
  { label: "탈삼진", desc: "K/IP 기반 (삼진 많을수록 높음)" },
  { label: "체력", desc: "총 투구 이닝 기반 (180이닝 = 최대)" },
  { label: "안정감", desc: "ERA 역수 (방어율 낮을수록 높음)" },
  { label: "지배력", desc: "WHIP 역수 (주자 허용 적을수록 높음)" },
];

export default function PlayerRadar({ playerId, position, teamColor }: PlayerRadarProps) {
  const [stats, setStats] = useState<{ label: string; value: number }[] | null>(null);
  const [rawStats, setRawStats] = useState<any>(null);
  const [activeTrait, setActiveTrait] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [showInfo, setShowInfo] = useState(false);
  const isPitcher = position === "투수" || position?.includes("투");

  useEffect(() => {
    fetch(`/api/player-stats?id=${playerId}&pos=${encodeURIComponent(position)}`)
      .then(r => r.json())
      .then(d => {
        if (d.stats) {
          setStats(isPitcher ? calcPitcherRadar(d.stats) : calcBatterRadar(d.stats));
          setRawStats(d.stats);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [playerId, position, isPitcher]);

  if (loading) return <div className="flex justify-center py-4"><div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" /></div>;
  if (!stats) return null;

  const infoItems = isPitcher ? PITCHER_INFO : BATTER_INFO;

  return (
    <div className="flex flex-col items-center gap-1 relative">
      <div className="w-full flex justify-end px-2">
        <button
          onClick={() => setShowInfo(!showInfo)}
          className="w-6 h-6 rounded-full border border-gray-600 text-gray-400 text-xs flex items-center justify-center hover:bg-white/10 transition"
        >
          i
        </button>
      </div>
      {showInfo && (
        <div className="w-full bg-white/5 rounded-xl p-3 mb-2 space-y-1.5">
          <p className="text-xs text-gray-400 font-medium mb-2">📊 항목별 계산 기준</p>
          {infoItems.map((item) => (
            <div key={item.label} className="flex gap-2 text-xs">
              <span className="font-semibold text-gray-300 w-14 shrink-0" style={{ color: teamColor }}>{item.label}</span>
              <span className="text-gray-500">{item.desc}</span>
            </div>
          ))}
          <p className="text-[10px] text-gray-600 mt-2">※ 점선 = 리그 평균, 2025 시즌 기준</p>
        </div>
      )}
      <RadarChart stats={stats} size={220} teamColor={teamColor} />
      <p className="text-[11px] text-gray-500">점선 = 리그 평균 기준</p>
      {/* 특성 뱃지 */}
      {rawStats && (() => {
        const traits = isPitcher ? getPitcherTraits(rawStats) : getBatterTraits(rawStats);
        if (traits.length === 0) return null;
        return (
          <div className="flex flex-wrap justify-center gap-2 mt-3 mb-6">
            {traits.map((t, i) => (
              <button key={i} onClick={() => setActiveTrait(activeTrait === i ? null : i)}
                className="inline-flex flex-col items-center gap-0.5 px-2.5 py-1 rounded-full text-xs font-medium bg-white/5 border border-white/10 transition-colors hover:bg-white/10">
                <span className="inline-flex items-center gap-1">
                  <span>{t.emoji}</span>
                  <span className="text-text-primary">{t.label}</span>
                  <span className="text-text-tertiary text-[10px]">{t.desc}</span>
                </span>
                {activeTrait === i && (
                  <span className="text-[10px] text-accent">{t.criteria}</span>
                )}
              </button>
            ))}
          </div>
        );
      })()}
    </div>
  );
}
