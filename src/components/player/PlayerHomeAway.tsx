"use client";

import { useState, useEffect } from "react";
import GlassCard from "@/components/ui/GlassCard";

interface GameLogRow {
  is_home: boolean;
  ab: number; h: number;
  ip_outs: number; er: number;
}

interface Side { ab: number; h: number; er: number; outs: number; }

/** 홈/원정 집계 (선수 스탯 V1.5) — game_logs.is_home 파생, 보조소스 불요.
 *  타자=홈/원정 타율(Σh/Σab), 투수=홈/원정 ERA(Σer*27/Σip_outs). */
function aggregate(rows: GameLogRow[]): { home: Side; away: Side } {
  const home: Side = { ab: 0, h: 0, er: 0, outs: 0 };
  const away: Side = { ab: 0, h: 0, er: 0, outs: 0 };
  for (const r of rows) {
    const s = r.is_home ? home : away;
    s.ab += r.ab; s.h += r.h; s.er += r.er; s.outs += r.ip_outs;
  }
  return { home, away };
}

function fmtAvg(h: number, ab: number): string {
  return ab > 0 ? (h / ab).toFixed(3).replace(/^0\./, ".") : "-";
}
function fmtEra(er: number, outs: number): string {
  return outs > 0 ? ((er * 27) / outs).toFixed(2) : "-";
}

export default function PlayerHomeAway({
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

  if (loading) return null;

  const { home, away } = aggregate(rows);
  const denom = (s: Side) => (isPitcher ? s.outs : s.ab);
  // 양쪽 다 분모 0이면 미표시 (fail-closed)
  if (denom(home) === 0 && denom(away) === 0) return null;

  const label = isPitcher ? "ERA" : "타율";
  const val = (s: Side) => (isPitcher ? fmtEra(s.er, s.outs) : fmtAvg(s.h, s.ab));

  const cell = (icon: string, name: string, s: Side) => (
    <div className="flex-1 text-center">
      <p className="text-xs text-text-tertiary mb-1">{icon} {name}</p>
      <p className="text-xl font-bold tabular-nums" style={{ color: teamColor }}>{val(s)}</p>
    </div>
  );

  return (
    <GlassCard className="p-4 mb-4">
      <h3 className="text-sm font-bold text-text-primary mb-3">🏠 홈/원정 {label}</h3>
      <div className="flex items-center gap-3">
        {cell("🏠", "홈", home)}
        <div className="w-px h-10 bg-border" />
        {cell("✈️", "원정", away)}
      </div>
    </GlassCard>
  );
}
