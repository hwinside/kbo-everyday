"use client";

import { useState, useEffect } from "react";
import GlassCard from "@/components/ui/GlassCard";
import { getTeamById } from "@/lib/constants/teams";
import { gameResultTone, resultToneChipStyle } from "@/lib/ui/result-tone";

interface GameLogRow {
  game_id: string;
  game_date: string; // YYYY-MM-DD
  team_code: string;
  opponent_team_id: number;
  is_home: boolean;
  result: "W" | "L" | "D";
  ab: number; h: number; hr: number; rbi: number; bb: number; so: number;
  ip_outs: number; er: number; h_allowed: number; k: number; bb_allowed: number;
}

/** ip_outs(총 아웃) → KBO 표기 IP ("16" → "5.1", "18" → "6"). */
function fmtIp(outs: number): string {
  const whole = Math.floor(outs / 3);
  const frac = outs % 3;
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** "2026-06-06" → "6.6" */
function fmtDate(d: string): string {
  const [, m, day] = d.split("-");
  return `${Number(m)}.${Number(day)}`;
}

/** 0.32 → ".320" (선행 0 제거) */
function fmtRate(v: number, digits: number): string {
  return v.toFixed(digits).replace(/^0\./, ".");
}

function ResultChip({ result }: { result: "W" | "L" | "D" }) {
  const label = result === "W" ? "승" : result === "L" ? "패" : "무";
  // 승패 색은 홈 팀카드 기준 SSOT(@/lib/ui/result-tone).
  return (
    <span
      className="inline-block px-1.5 py-0.5 rounded text-[11px] font-bold"
      style={resultToneChipStyle(gameResultTone(result))}
    >
      {label}
    </span>
  );
}

type RowWithCum = GameLogRow & { avg: string; era: string };

/** game_date 오름차순 rows에 시즌누적 AVG/ERA를 부여 (순수 — 렌더 밖에서 계산). */
function withCumulative(rows: GameLogRow[]): RowWithCum[] {
  let cumAb = 0, cumH = 0, cumEr = 0, cumOuts = 0;
  return rows.map((r) => {
    cumAb += r.ab; cumH += r.h; cumEr += r.er; cumOuts += r.ip_outs;
    const avg = cumAb > 0 ? fmtRate(cumH / cumAb, 3) : "-";
    const era = cumOuts > 0 ? ((cumEr * 27) / cumOuts).toFixed(2) : "-";
    return { ...r, avg, era };
  });
}

const RECENT_LIMIT = 10;

export default function PlayerGameLogs({
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
  const [expanded, setExpanded] = useState(false);
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
      <div className="px-5 py-4">
        <GlassCard className="p-4 text-center text-text-tertiary text-sm">경기별 기록 불러오는 중…</GlassCard>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="px-5 py-4">
        <GlassCard className="p-4 text-center text-text-tertiary text-sm">2026 시즌 경기별 기록이 없습니다</GlassCard>
      </div>
    );
  }

  // rows는 game_date 오름차순. 누적 AVG/ERA를 시간순으로 계산한 뒤 표시용으로 최신순 뒤집는다.
  const withCum = withCumulative(rows);
  const desc = [...withCum].reverse();
  const visible = expanded ? desc : desc.slice(0, RECENT_LIMIT);

  // 최근 폼 스트립: 최신 10경기, 좌(과거)→우(최신)
  const recent = withCum.slice(-RECENT_LIMIT);

  const oppLabel = (r: GameLogRow) => {
    const opp = getTeamById(r.opponent_team_id)?.shortName ?? "?";
    return `${r.is_home ? "vs" : "@"} ${opp}`;
  };

  return (
    <div className="px-5 py-4 space-y-4">
      {/* 최근 폼 스트립 */}
      <GlassCard className="p-4">
        <h3 className="text-sm font-bold text-text-primary mb-3">최근 {recent.length}경기</h3>
        <div className="flex gap-1.5">
          {recent.map((r) => (
            <div
              key={r.game_id}
              className="flex-1 aspect-square rounded flex items-center justify-center text-xs font-bold"
              style={resultToneChipStyle(gameResultTone(r.result))}
            >
              {r.result === "W" ? "승" : r.result === "L" ? "패" : "무"}
            </div>
          ))}
        </div>
      </GlassCard>

      {/* 경기별 표 */}
      <GlassCard className="p-4 overflow-x-auto">
        <h3 className="text-sm font-bold text-text-primary mb-3">경기별 기록</h3>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-tertiary border-b border-border">
              <th className="text-left py-1.5 pr-2">날짜</th>
              <th className="text-left py-1.5 px-2">상대</th>
              <th className="text-center py-1.5 px-2">결과</th>
              {isPitcher ? (
                <>
                  <th className="text-right py-1.5 px-2">IP</th>
                  <th className="text-right py-1.5 px-2">H</th>
                  <th className="text-right py-1.5 px-2">ER</th>
                  <th className="text-right py-1.5 px-2">K</th>
                  <th className="text-right py-1.5 px-2">BB</th>
                  <th className="text-right py-1.5 pl-2">ERA</th>
                </>
              ) : (
                <>
                  <th className="text-right py-1.5 px-2">타수</th>
                  <th className="text-right py-1.5 px-2">안타</th>
                  <th className="text-right py-1.5 px-2">HR</th>
                  <th className="text-right py-1.5 px-2">타점</th>
                  <th className="text-right py-1.5 pl-2">타율</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.game_id} className="border-b border-border/50">
                <td className="py-1.5 pr-2 text-text-secondary tabular-nums whitespace-nowrap">{fmtDate(r.game_date)}</td>
                <td className="py-1.5 px-2 text-text-primary whitespace-nowrap">{oppLabel(r)}</td>
                <td className="py-1.5 px-2 text-center"><ResultChip result={r.result} /></td>
                {isPitcher ? (
                  <>
                    <td className="text-right py-1.5 px-2 tabular-nums text-text-primary">{fmtIp(r.ip_outs)}</td>
                    <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{r.h_allowed}</td>
                    <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{r.er}</td>
                    <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{r.k}</td>
                    <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{r.bb_allowed}</td>
                    <td className="text-right py-1.5 pl-2 tabular-nums font-semibold" style={{ color: teamColor }}>{r.era}</td>
                  </>
                ) : (
                  <>
                    <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{r.ab}</td>
                    <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{r.h}</td>
                    <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{r.hr}</td>
                    <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{r.rbi}</td>
                    <td className="text-right py-1.5 pl-2 tabular-nums font-semibold" style={{ color: teamColor }}>{r.avg}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>

        {desc.length > RECENT_LIMIT && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="w-full mt-3 py-2 text-xs font-medium text-text-secondary bg-bg-tertiary rounded-lg transition-colors"
          >
            {expanded ? "접기" : `더보기 (전체 ${desc.length}경기)`}
          </button>
        )}
      </GlassCard>
    </div>
  );
}
