"use client";

import { useState, useEffect } from "react";
import GlassCard from "@/components/ui/GlassCard";

interface Split {
  label: string;
  avg: string; // 투수=피안타율, 타자=타율 ("0.234")
  hr: number;
  rbi: number;
  so: number;
}

/** 선수 상황별 스플릿 (선수 스탯 V1) — KBO Situation.aspx 실데이터(/api/player-situation).
 *  투수: vs좌타/vs우타/득점권 → 피안타율 + 삼진
 *  타자: vs좌투/vs우투/득점권 → 타율 + 홈런 + 타점
 *  데이터 없으면 조용히 미표시(fail-closed). */
export default function PlayerSplitTable({
  playerId,
  position,
  teamColor,
}: {
  playerId: string;
  position: string;
  teamColor: string;
}) {
  const [splits, setSplits] = useState<Split[]>([]);
  const [loading, setLoading] = useState(true);
  const isPitcher = position === "투수";

  useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetch(`/api/player-situation?id=${encodeURIComponent(playerId)}&pos=${encodeURIComponent(position)}`)
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
  }, [playerId, position]);

  if (loading || splits.length === 0) return null;

  const fmtAvg = (a: string) => a.replace(/^0\./, ".");

  return (
    <GlassCard className="p-4 overflow-x-auto">
      <h3 className="text-sm font-bold text-text-primary mb-3">🆚 상황별 스플릿</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-text-tertiary border-b border-border">
            <th className="text-left py-1.5 pr-2">상황</th>
            <th className="text-right py-1.5 px-2">{isPitcher ? "피안타율" : "타율"}</th>
            {isPitcher ? (
              <th className="text-right py-1.5 pl-2">삼진</th>
            ) : (
              <>
                <th className="text-right py-1.5 px-2">홈런</th>
                <th className="text-right py-1.5 pl-2">타점</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {splits.map((s) => (
            <tr key={s.label} className="border-b border-border/50">
              <td className="py-1.5 pr-2 font-medium text-text-primary whitespace-nowrap">{s.label}</td>
              <td className="text-right py-1.5 px-2 tabular-nums font-semibold" style={{ color: teamColor }}>{fmtAvg(s.avg)}</td>
              {isPitcher ? (
                <td className="text-right py-1.5 pl-2 tabular-nums text-text-secondary">{s.so}</td>
              ) : (
                <>
                  <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{s.hr}</td>
                  <td className="text-right py-1.5 pl-2 tabular-nums text-text-secondary">{s.rbi}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-text-tertiary mt-3 text-center">※ KBO 공식 상황별 기록 기반</p>
    </GlassCard>
  );
}
