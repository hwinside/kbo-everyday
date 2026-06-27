"use client";

import { useState, useEffect } from "react";
import GlassCard from "@/components/ui/GlassCard";
import TrendChart from "@/components/stats/TrendChart";
import type { PlayerGameLog, PitcherGameLog } from "@/lib/constants/players";
import { toWeeklyTrend, type WeeklyTrendRow } from "@/lib/stats/weekly-trend";

type GameLogRow = WeeklyTrendRow;

export default function PlayerWeeklyTrend({
  playerId,
  position,
  teamColor,
}: {
  playerId: string;
  position: string;
  teamColor: string;
}) {
  const [rows, setRows] = useState<GameLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const isPitcher = position === "투수";

  useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetch(`/api/player-game-logs?id=${encodeURIComponent(playerId)}&pos=${encodeURIComponent(position)}`)
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((d) => {
        if (alive) setRows(Array.isArray(d.rows) ? d.rows : []);
      })
      .catch(() => {
        if (alive) setRows([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [playerId, position]);

  if (loading) {
    return (
      <GlassCard className="p-4 mb-4 text-center text-text-tertiary text-sm">주간 추이 불러오는 중…</GlassCard>
    );
  }

  const trend = toWeeklyTrend(rows, isPitcher);
  if (trend.length < 2) return null; // 추이는 2주 이상부터 의미

  return (
    <GlassCard className="p-4 mb-4">
      <h3 className="text-sm font-bold text-text-primary mb-1">📈 주간 추이</h3>
      <p className="text-xs text-text-tertiary mb-3">{isPitcher ? "주간 평균자책(ERA)" : "주간 타율"}</p>
      <TrendChart data={trend as PlayerGameLog[] | PitcherGameLog[]} teamColor={teamColor} isPitcher={isPitcher} />
    </GlassCard>
  );
}
