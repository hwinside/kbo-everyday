"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import GlassCard from "@/components/ui/GlassCard";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { getCanonicalPlayerHref } from "@/lib/utils/resolve-player";
import { TEAMS } from "@/lib/constants/teams";
import { getMyTeamId } from "@/lib/store/myteam";
import { STAT_DEFS, type StatType } from "@/lib/stats/title-defs";
import { rankByStat, type RankedRow } from "@/lib/stats/title-rankings";

/* 기록실 노출 스탯 (STAT_DEFS 키, type별 큐레이션) */
const BATTER_STATS = ["hr", "avg", "ops", "obp", "rbi", "runs", "sb", "bb", "doubles", "so_batter", "games_batter"];
const PITCHER_STATS = ["era", "wins", "saves", "holds", "so_pitcher", "whip", "ip", "games_pitcher"];

type Row = Record<string, unknown> & {
  name: string;
  team?: string;
  teamId?: number;
  kboId?: string;
  playerId?: string;
};

function teamIdFromText(team?: string): number | null {
  if (!team) return null;
  return TEAMS.find((t) => t.shortName === team || t.name === team)?.id ?? null;
}

function hexToRgba(hex: string, alpha: number): string {
  const c = hex.replace("#", "");
  const full = c.length === 3 ? c.split("").map((x) => x + x).join("") : c;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 선수기록실 — 스탯 선택 시 그 순으로 정렬된 랭킹 리스트.
 * scopeTeamId 있으면 해당 팀 내 정렬(팀 페이지), 없으면 리그 전체(선수 탭).
 * 데이터/정렬/자격은 랭킹 페이지와 동일 SSOT(/api/stats + rankByStat) 재사용.
 */
export default function RecordRoom({ scopeTeamId }: { scopeTeamId?: number }) {
  const [statType, setStatType] = useState<StatType>("batter");
  const [activeStat, setActiveStat] = useState<string>("hr");
  const [rowsByType, setRowsByType] = useState<Record<string, Row[]>>({});
  const [myTeamId, setMyTeamId] = useState<number | null>(null);
  const loading = rowsByType[statType] === undefined;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMyTeamId(getMyTeamId());
  }, []);

  useEffect(() => {
    if (rowsByType[statType] !== undefined) return;
    fetch(`/api/stats?type=${statType}&season=2026`)
      .then((r) => r.json())
      .then((data: { stats?: Row[] }) =>
        setRowsByType((prev) => ({ ...prev, [statType]: data.stats || [] }))
      )
      .catch(() => setRowsByType((prev) => ({ ...prev, [statType]: [] })));
  }, [statType, rowsByType]);

  const chips = statType === "batter" ? BATTER_STATS : PITCHER_STATS;
  const def = STAT_DEFS[activeStat];

  const ranked = useMemo(() => {
    const rows = rowsByType[statType] || [];
    const scoped =
      scopeTeamId != null
        ? rows.filter((p) => (p.teamId ?? teamIdFromText(p.team)) === scopeTeamId)
        : rows;
    return rankByStat(scoped, activeStat) as (RankedRow & Row)[];
  }, [rowsByType, statType, activeStat, scopeTeamId]);

  function switchType(t: StatType) {
    if (t === statType) return;
    setStatType(t);
    setActiveStat(t === "batter" ? "hr" : "era");
  }

  const getValue = (p: Row): number => {
    if (!def) return 0;
    if (activeStat === "doubles") return (Number(p.doubles) || 0) + (Number(p.triples) || 0);
    return Number(p[def.key] ?? 0) || 0;
  };
  const fmt = (v: number) => (def?.format ? def.format(v) : String(v));

  return (
    <div>
      {/* 타자/투수 토글 */}
      <div className="mb-3 flex gap-1 rounded-lg bg-bg-glass/40 p-1">
        {(["batter", "pitcher"] as StatType[]).map((t) => (
          <button
            key={t}
            onClick={() => switchType(t)}
            className={`flex-1 rounded-md py-2 text-sm font-semibold transition-all ${
              statType === t ? "bg-accent text-white shadow-sm" : "text-text-tertiary"
            }`}
          >
            {t === "batter" ? "타자" : "투수"}
          </button>
        ))}
      </div>

      {/* 스탯 칩 (선택 시 정렬 기준) */}
      <div className="mb-4 flex gap-2 overflow-x-auto hide-scrollbar pb-1">
        {chips.map((key) => {
          const d = STAT_DEFS[key];
          if (!d) return null;
          const label = d.desc.replace(/\s*랭킹.*$/, "").replace(/\s*\(.*\)\s*$/, "").trim();
          return (
            <button
              key={key}
              onClick={() => setActiveStat(key)}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                activeStat === key
                  ? "bg-accent text-white"
                  : "bg-bg-secondary/60 text-text-tertiary"
              }`}
            >
              {d.emoji} {label}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="py-16 text-center text-text-tertiary text-sm">로딩 중...</div>
      ) : ranked.length === 0 ? (
        <div className="py-16 text-center text-text-tertiary text-sm">
          기록이 아직 없습니다
        </div>
      ) : (
        <div className="space-y-2 pb-24">
          {ranked.map((p, i) => {
            const teamId = (typeof p.teamId === "number" ? p.teamId : null) ?? teamIdFromText(p.team) ?? 0;
            const isMyTeam = myTeamId != null && teamId === myTeamId;
            const teamColor = TEAMS.find((t) => t.id === teamId)?.colorPrimary || "#FF6B35";
            const rank = p.rank || i + 1;

            const cardStyle: CSSProperties | undefined = isMyTeam
              ? { borderLeft: `3px solid ${hexToRgba(teamColor, 0.8)}`, backgroundColor: hexToRgba(teamColor, 0.12) }
              : undefined;

            const href =
              getCanonicalPlayerHref({ name: p.name, kboId: p.kboId, playerId: p.playerId, teamId }) ??
              `/community/players/${p.kboId || p.playerId || p.name}`;

            return (
              <Link key={p.kboId || p.playerId || `${p.name}-${i}`} href={href}>
                <GlassCard pressable className="p-3 flex items-center gap-3" style={cardStyle}>
                  <span
                    className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold flex-shrink-0 ${
                      rank === 1
                        ? "bg-yellow-500/20 text-yellow-400"
                        : rank === 2
                          ? "bg-gray-400/20 text-gray-300"
                          : rank === 3
                            ? "bg-amber-700/20 text-amber-600"
                            : "bg-bg-tertiary text-text-tertiary"
                    }`}
                  >
                    {rank}
                  </span>
                  <PlayerAvatar
                    name={p.name}
                    teamId={teamId}
                    photoUrl={getPlayerPhotoUrl(p.name, p.kboId || p.playerId, teamId)}
                    size={44}
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-semibold text-text-primary">{p.name}</span>
                    <span className="ml-1.5 text-xs text-text-tertiary">{p.team}</span>
                  </div>
                  <span className="text-lg font-bold tabular-nums text-text-primary">{fmt(getValue(p))}</span>
                </GlassCard>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
