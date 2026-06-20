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
import { calcBatterSaber, calcPitcherSaber } from "@/lib/utils/sabermetrics-calc";
import playerPositions from "@/lib/constants/player-positions.json";

const POSITIONS = playerPositions as Record<string, string>;

/* 기록실 뷰 — 타자/투수/수비. WAR는 STAT_DEFS 밖 특수 처리(자체 산식). */
type View = StatType | "defense";

/* 기록실 노출 스탯 — "war"(예상 WAR)는 STAT_DEFS 밖 특수 처리(자체 산식 계산) */
const BATTER_STATS = ["war", "hr", "avg", "ops", "obp", "rbi", "runs", "sb", "bb", "doubles", "so_batter", "games_batter"];
const PITCHER_STATS = ["war", "era", "wins", "saves", "holds", "so_pitcher", "whip", "ip", "games_pitcher"];

/* 수비 스탯 — STAT_DEFS 밖 로컬 정의(수비기록은 정적 크롤 JSON 집계, /api/stats?type=defense) */
const DEFENSE_STATS = ["fpct", "poa", "dp", "innings", "e"];
const DEF_DEFS: Record<string, { label: string; emoji: string; fmt: (v: number) => string; rate?: boolean }> = {
  fpct: { label: "수비율", emoji: "🧤", fmt: (v) => v.toFixed(3).replace(/^0/, ""), rate: true },
  poa: { label: "자살+보살", emoji: "🎯", fmt: (v) => String(v) },
  dp: { label: "병살", emoji: "⚡", fmt: (v) => String(v) },
  innings: { label: "수비이닝", emoji: "⏱️", fmt: (v) => v.toFixed(0) },
  e: { label: "실책", emoji: "❌", fmt: (v) => String(v) },
};
const FPCT_MIN_INN = 100; // 수비율 리더보드 자격(저이닝 1.000 노이즈 방지)

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

/* 자체 "예상 WAR" 계산 (타격+주루+포지션; 수비는 네이버 대비 정확도 저하로 미반영) */
function computeWar(p: Row, statType: StatType): number {
  if (statType === "batter") {
    return calcBatterSaber({
      avg: (p.avg as string | number) ?? 0, hits: Number(p.hits) || 0, hr: Number(p.hr) || 0,
      doubles: Number(p.doubles) || 0, triples: Number(p.triples) || 0, ab: Number(p.ab) || 0,
      pa: Number(p.pa) || 0, runs: Number(p.runs) || 0, rbi: Number(p.rbi) || 0,
      sb: Number(p.sb) || 0, bb: Number(p.bb) || 0, so: Number(p.so) || 0,
      hbp: Number(p.hbp) || 0, cs: Number(p.cs) || 0,
      position: POSITIONS[String(p.kboId ?? p.playerId ?? "")],
    }).WAR;
  }
  return calcPitcherSaber({
    era: (p.era as string | number) ?? 0, ip: (p.ip as string | number) ?? 0,
    so: Number(p.so) || 0, bb: Number(p.bb) || 0, hr: Number(p.hr) || 0, hits: Number(p.h) || 0,
    games: Number(p.games) || 0, wins: Number(p.wins) || 0, losses: Number(p.losses) || 0,
    saves: Number(p.saves) || 0, whip: (p.whip as string | number) ?? 0,
  }).WAR;
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
 * 타자/투수: /api/stats + rankByStat SSOT 재사용. 수비: 정적 크롤 JSON 집계(type=defense).
 */
export default function RecordRoom({ scopeTeamId }: { scopeTeamId?: number }) {
  const [view, setView] = useState<View>("batter");
  const [activeStat, setActiveStat] = useState<string>("war");
  const [rowsByType, setRowsByType] = useState<Record<string, Row[]>>({});
  const [myTeamId, setMyTeamId] = useState<number | null>(null);
  const loading = rowsByType[view] === undefined;
  const isDefense = view === "defense";

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMyTeamId(getMyTeamId());
  }, []);

  useEffect(() => {
    if (rowsByType[view] !== undefined) return;
    fetch(`/api/stats?type=${view}&season=2026`)
      .then((r) => r.json())
      .then((data: { stats?: Row[] }) =>
        setRowsByType((prev) => ({ ...prev, [view]: data.stats || [] }))
      )
      .catch(() => setRowsByType((prev) => ({ ...prev, [view]: [] })));
  }, [view, rowsByType]);

  const chips = isDefense ? DEFENSE_STATS : view === "batter" ? BATTER_STATS : PITCHER_STATS;
  const def = STAT_DEFS[activeStat];

  const ranked = useMemo(() => {
    const rows = rowsByType[view] || [];
    const scoped =
      scopeTeamId != null
        ? rows.filter((p) => (p.teamId ?? teamIdFromText(p.team)) === scopeTeamId)
        : rows;

    if (isDefense) {
      // 수비: 선택 스탯 내림차순. 수비율(rate)은 최소 이닝 자격 적용.
      const dd = DEF_DEFS[activeStat] ?? DEF_DEFS.fpct;
      const pool = dd.rate ? scoped.filter((p) => (Number(p.innings) || 0) >= FPCT_MIN_INN) : scoped;
      const sorted = [...pool].sort((a, b) => (Number(b[activeStat]) || 0) - (Number(a[activeStat]) || 0));
      let prevV: number | null = null, prevR = 0;
      return sorted.map((p, i) => {
        const v = Number(p[activeStat]) || 0;
        const r = i > 0 && v === prevV ? prevR : i + 1;
        prevV = v; prevR = r;
        return { ...p, rank: r };
      }) as (RankedRow & Row)[];
    }

    if (activeStat === "war") {
      // 예상 WAR: 자체 산식 계산 → 자격(타자 10경기 / 투수 5경기) → 내림차순 → 공동순위
      const minG = view === "batter" ? 10 : 5;
      const withWar = scoped
        .filter((p) => (Number(p.games) || 0) >= minG)
        .map((p) => ({ ...p, __war: computeWar(p, view as StatType) }))
        .sort((a, b) => b.__war - a.__war);
      let prevV: number | null = null, prevR = 0;
      return withWar.map((p, i) => {
        const r = i > 0 && p.__war === prevV ? prevR : i + 1;
        prevV = p.__war; prevR = r;
        return { ...p, rank: r };
      }) as (RankedRow & Row)[];
    }
    return rankByStat(scoped, activeStat) as (RankedRow & Row)[];
  }, [rowsByType, view, activeStat, scopeTeamId, isDefense]);

  function switchView(t: View) {
    if (t === view) return;
    setView(t);
    setActiveStat(t === "defense" ? "fpct" : "war"); // 수비 기본=수비율, 그 외=예상 WAR
  }

  const getValue = (p: Row): number => {
    if (isDefense) return Number(p[activeStat]) || 0;
    if (activeStat === "war") return Number((p as Row & { __war?: number }).__war) || 0;
    if (!def) return 0;
    if (activeStat === "doubles") return (Number(p.doubles) || 0) + (Number(p.triples) || 0);
    return Number(p[def.key] ?? 0) || 0;
  };
  const fmt = (v: number) => {
    if (isDefense) return (DEF_DEFS[activeStat] ?? DEF_DEFS.fpct).fmt(v);
    if (activeStat === "war") return v.toFixed(1);
    return def?.format ? def.format(v) : String(v);
  };

  return (
    <div>
      {/* 타자/투수/수비 토글 */}
      <div className="mb-3 flex gap-1 rounded-lg bg-bg-glass/40 p-1">
        {(["batter", "pitcher", "defense"] as View[]).map((t) => (
          <button
            key={t}
            onClick={() => switchView(t)}
            className={`flex-1 rounded-md py-2 text-sm font-semibold transition-all ${
              view === t ? "bg-accent text-white shadow-sm" : "text-text-tertiary"
            }`}
          >
            {t === "batter" ? "타자" : t === "pitcher" ? "투수" : "수비"}
          </button>
        ))}
      </div>

      {/* 스탯 칩 (선택 시 정렬 기준) */}
      <div className="mb-4 flex gap-2 overflow-x-auto hide-scrollbar pb-1">
        {chips.map((key) => {
          if (isDefense) {
            const d = DEF_DEFS[key];
            if (!d) return null;
            return (
              <button
                key={key}
                onClick={() => setActiveStat(key)}
                className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                  activeStat === key ? "bg-accent text-white" : "bg-bg-secondary/60 text-text-tertiary"
                }`}
              >
                {d.emoji} {d.label}
              </button>
            );
          }
          const isWar = key === "war";
          const d = STAT_DEFS[key];
          if (!isWar && !d) return null;
          const label = isWar
            ? "예상 WAR"
            : d!.desc.replace(/\s*랭킹.*$/, "").replace(/\s*\(.*\)\s*$/, "").trim();
          const emoji = isWar ? "📈" : d!.emoji;
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
              {emoji} {label}
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
                    {isDefense && p.position ? (
                      <span className="ml-1.5 text-xs text-text-tertiary">· {String(p.position)}</span>
                    ) : null}
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
