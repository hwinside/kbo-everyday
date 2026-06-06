"use client";

import { useState, useEffect } from "react";
import GlassCard from "@/components/ui/GlassCard";

interface Split {
  label: string;
  avg: string; // 피안타율 "0.234"
  so: number; // 삼진
}

/** 투수 상황별 스플릿 (선수 스탯 V1 빌드4) — vs좌타/vs우타/득점권 피안타율 + 삼진.
 *  KBO Situation.aspx 실데이터(/api/player-situation). 데이터 없으면 조용히 미표시(fail-closed). */
export default function PitcherSplitTable({ playerId, teamColor }: { playerId: string; teamColor: string }) {
  const [splits, setSplits] = useState<Split[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetch(`/api/player-situation?id=${encodeURIComponent(playerId)}&pos=${encodeURIComponent("투수")}`)
      .then((r) => (r.ok ? r.json() : { splits: [] }))
      .then((d) => {
        if (alive) setSplits(Array.isArray(d.splits) ? d.splits : []);
      })
      .catch(() => {
        if (alive) setSplits([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [playerId]);

  if (loading || splits.length === 0) return null;

  const fmtAvg = (a: string) => a.replace(/^0\./, ".");

  return (
    <GlassCard className="p-4 overflow-x-auto">
      <h3 className="text-sm font-bold text-text-primary mb-3">🆚 상황별 스플릿</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-text-tertiary border-b border-border">
            <th className="text-left py-1.5 pr-2">상황</th>
            <th className="text-right py-1.5 px-2">피안타율</th>
            <th className="text-right py-1.5 pl-2">삼진</th>
          </tr>
        </thead>
        <tbody>
          {splits.map((s) => (
            <tr key={s.label} className="border-b border-border/50">
              <td className="py-1.5 pr-2 font-medium text-text-primary whitespace-nowrap">{s.label}</td>
              <td className="text-right py-1.5 px-2 tabular-nums font-semibold" style={{ color: teamColor }}>{fmtAvg(s.avg)}</td>
              <td className="text-right py-1.5 pl-2 tabular-nums text-text-secondary">{s.so}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-text-tertiary mt-3 text-center">※ KBO 공식 상황별 기록 기반</p>
    </GlassCard>
  );
}
