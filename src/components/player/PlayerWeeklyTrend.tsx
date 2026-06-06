"use client";

import { useState, useEffect } from "react";
import GlassCard from "@/components/ui/GlassCard";
import TrendChart from "@/components/stats/TrendChart";
import type { PlayerGameLog, PitcherGameLog } from "@/lib/constants/players";

interface GameLogRow {
  game_date: string; // YYYY-MM-DD
  ab: number; h: number;
  ip_outs: number; er: number;
}

/** YYYY-MM-DD → 그 주(ISO, 월요일 시작) 월요일의 "M/D" 라벨 + 정렬키. */
function weekOf(dateStr: string): { key: string; label: string } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=일 .. 6=토
  const offset = dow === 0 ? -6 : 1 - dow; // 월요일까지
  dt.setUTCDate(dt.getUTCDate() + offset);
  const mm = dt.getUTCMonth() + 1;
  const dd = dt.getUTCDate();
  const key = `${dt.getUTCFullYear()}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  return { key, label: `${mm}/${dd}` };
}

/** 출전 경기(game_date asc) → 주간 타율/ERA 시계열. 분모 0 주는 제외. */
function toWeeklyTrend(rows: GameLogRow[], isPitcher: boolean): (PlayerGameLog | PitcherGameLog)[] {
  const buckets = new Map<string, { label: string; ab: number; h: number; er: number; outs: number }>();
  for (const r of rows) {
    const { key, label } = weekOf(r.game_date);
    const b = buckets.get(key) ?? { label, ab: 0, h: 0, er: 0, outs: 0 };
    b.ab += r.ab; b.h += r.h; b.er += r.er; b.outs += r.ip_outs;
    buckets.set(key, b);
  }
  const sorted = [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (isPitcher) {
    return sorted
      .filter(([, b]) => b.outs > 0)
      .map(([, b]) => ({ date: b.label, era: (b.er * 27) / b.outs, whip: 0 }));
  }
  return sorted
    .filter(([, b]) => b.ab > 0)
    .map(([, b]) => ({ date: b.label, avg: b.h / b.ab, ops: 0 }));
}

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
