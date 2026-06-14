"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import PlayerAvatar from "@/components/ui/PlayerAvatar";
import SectionHeader from "@/components/ui/SectionHeader";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { getTeamById } from "@/lib/constants/teams";
import type { FavoritePlayer } from "@/lib/store/favorites";
import batterStats from "@/lib/constants/stats-2026-batters.json";
import pitcherStats from "@/lib/constants/stats-2026-pitchers.json";
import rosterData from "@/lib/constants/players-roster.json";

interface RosterEntry {
  name: string;
  kboId: string;
  backNo: string;
  position: string;
  teamId: number;
  team: string;
}

const rosterMap = new Map(
  (rosterData as RosterEntry[]).filter((r) => r.backNo).map((r) => [r.kboId, r])
);

interface BatterStat {
  playerId: string;
  name: string;
  team: string;
  avg: string;
  hr: number;
  rbi: number;
  ops: string;
  games: number;
}

interface PitcherStat {
  playerId: string;
  name: string;
  team: string;
  era: string;
  ip: string;
  so: number;
  whip: string;
  games: number;
  wins: number;
  losses: number;
  saves: number;
}

const batterMap = new Map(
  (batterStats as BatterStat[]).map((s) => [s.playerId, s])
);
const pitcherMap = new Map(
  (pitcherStats as PitcherStat[]).map((s) => [s.playerId, s])
);

// Fallback: 동명이인 등 playerId 불일치 시 name+team으로 재검색
function findBatter(playerId: string, name: string, teamId: number): BatterStat | undefined {
  const direct = batterMap.get(playerId);
  if (direct) return direct;
  const teamShort = getTeamById(teamId)?.shortName;
  return (batterStats as BatterStat[]).find((s) => s.name === name && s.team === teamShort);
}

function findPitcher(playerId: string, name: string, teamId: number): PitcherStat | undefined {
  const direct = pitcherMap.get(playerId);
  if (direct) return direct;
  const teamShort = getTeamById(teamId)?.shortName;
  return (pitcherStats as PitcherStat[]).find((s) => s.name === name && s.team === teamShort);
}

// 정적 스냅샷 기준 투수 분류 (라이브 fetch의 pos 결정 + 표시 블록 선택에 공통 사용).
// 기존 분류 로직 유지 — 라이브 연동은 "값"만 갱신하고 분류는 바꾸지 않음.
function classifyIsPitcher(p: FavoritePlayer): boolean {
  const batter = findBatter(p.playerId, p.name, p.teamId);
  const pitcher = findPitcher(p.playerId, p.name, p.teamId);
  return pitcher ? (!batter || p.position === "투수") : false;
}

// 라이브 소스(/api/player-stats)는 선수 상세 페이지 히어로와 동일 — 카드/페이지 숫자 일치 보장.
type StatLike = Record<string, string | number | undefined>;

export default function FavoritePlayersSection({ favPlayers }: { favPlayers: FavoritePlayer[] }) {
  const [liveStats, setLiveStats] = useState<Record<string, StatLike>>({});
  const favKey = useMemo(() => favPlayers.map((p) => p.playerId).join(","), [favPlayers]);

  // 선수 상세 페이지와 동일한 /api/player-stats 라이브 소스로 스탯 갱신.
  // 비-투수는 어떤 pos든 KBO 타자 상세로 크롤링되므로 상세 페이지 히어로와 정확히 같은 값.
  useEffect(() => {
    if (favPlayers.length === 0) {
      setLiveStats({});
      return;
    }
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        favPlayers.map(async (p) => {
          const pos = classifyIsPitcher(p) ? "투수" : "타자";
          try {
            const res = await fetch(
              `/api/player-stats?id=${encodeURIComponent(p.playerId)}&pos=${encodeURIComponent(pos)}`
            );
            if (!res.ok) return [p.playerId, null] as const;
            const data = await res.json();
            return [p.playerId, (data?.stats as StatLike | null) ?? null] as const;
          } catch {
            return [p.playerId, null] as const;
          }
        })
      );
      if (cancelled) return;
      const map: Record<string, StatLike> = {};
      for (const [id, stats] of results) if (stats) map[id] = stats;
      setLiveStats(map);
    })();
    return () => {
      cancelled = true;
    };
    // favKey로 최애선수 변경만 감지 (favPlayers 배열 identity 변동에 따른 재요청 방지)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favKey]);

  if (favPlayers.length === 0) return null;

  return (
    <div>
      <SectionHeader title="⭐ 나의 최애 선수" />
      <div className="flex gap-3 overflow-x-auto hide-scrollbar pb-2">
        {favPlayers.map((player) => {
          const live = liveStats[player.playerId];
          const isPitcher = classifyIsPitcher(player);
          const staticBatter = findBatter(player.playerId, player.name, player.teamId);
          const staticPitcher = findPitcher(player.playerId, player.name, player.teamId);

          // 라이브 우선, 없으면(미도착/실패) 정적 스냅샷 폴백 → 빈화면 방지
          let batterView: { avg: string; hr: number; rbi: number; ops: string } | null = null;
          let pitcherView: { era: string; wins: number; losses: number; saves: number; ip: string; so: number } | null = null;
          if (isPitcher) {
            const src = (live ?? (staticPitcher as unknown as StatLike | undefined)) as StatLike | undefined;
            if (src) {
              pitcherView = {
                era: String(src.era ?? "0.00"),
                wins: Number(src.wins ?? 0),
                losses: Number(src.losses ?? 0),
                saves: Number(src.saves ?? 0),
                ip: String(src.ip ?? "0"),
                so: Number(src.so ?? 0),
              };
            }
          } else {
            const src = (live ?? (staticBatter as unknown as StatLike | undefined)) as StatLike | undefined;
            if (src) {
              batterView = {
                avg: String(src.avg ?? ".000"),
                hr: Number(src.hr ?? 0),
                rbi: Number(src.rbi ?? 0),
                ops: String(src.ops ?? ".000"),
              };
            }
          }
          const hasStats = !!batterView || !!pitcherView;
          // roster에서 실제 등번호 가져오기 (favorite 저장값이 0인 경우 대응)
          const rosterEntry = rosterMap.get(player.playerId);
          const displayNumber = (player.number && player.number !== 0)
            ? player.number
            : rosterEntry?.backNo
              ? Number(rosterEntry.backNo)
              : null;

          return (
            <Link key={player.playerId} href={`/community/players/${player.playerId}`}>
              <div
                className="min-w-[160px] min-h-[200px] rounded-2xl p-3 flex flex-col items-center gap-2 border border-border bg-bg-secondary"
              >
                <PlayerAvatar
                  name={player.name}
                  teamId={player.teamId}
                  photoUrl={getPlayerPhotoUrl(player.name, player.playerId)}
                  number={displayNumber ?? player.number}
                  size={56}
                />
                <div className="text-center">
                  <p className="text-[15px] leading-[22px] font-medium text-text-primary">{player.name}</p>
                  {displayNumber ? (
                    <p className="text-xs leading-[18px] text-text-tertiary">#{displayNumber} {player.position}</p>
                  ) : (
                    <p className="text-xs leading-[18px] text-text-tertiary">{player.position}</p>
                  )}
                </div>
                {hasStats ? (
                  <div className="w-full space-y-1">
                    {pitcherView ? (
                      <>
                        <div className="flex justify-between text-xs leading-[18px]">
                          <span className="text-text-tertiary">ERA</span>
                          <span className="font-medium tabular-nums text-text-primary">{pitcherView.era}</span>
                        </div>
                        <div className="flex justify-between text-xs leading-[18px]">
                          <span className="text-text-tertiary">승·패·세</span>
                          <span className="font-medium tabular-nums text-text-primary">{pitcherView.wins} · {pitcherView.losses} · {pitcherView.saves}</span>
                        </div>
                        <div className="flex justify-between text-xs leading-[18px]">
                          <span className="text-text-tertiary">이닝·K</span>
                          <span className="font-medium tabular-nums text-text-primary">{pitcherView.ip} · {pitcherView.so}</span>
                        </div>
                      </>
                    ) : batterView ? (
                      <>
                        <div className="flex justify-between text-xs leading-[18px]">
                          <span className="text-text-tertiary">타율</span>
                          <span className="font-medium tabular-nums text-text-primary">{Number(batterView.avg).toFixed(3)}</span>
                        </div>
                        <div className="flex justify-between text-xs leading-[18px]">
                          <span className="text-text-tertiary">HR·타점</span>
                          <span className="font-medium tabular-nums text-text-primary">{batterView.hr} · {batterView.rbi}</span>
                        </div>
                        <div className="flex justify-between text-xs leading-[18px]">
                          <span className="text-text-tertiary">OPS</span>
                          <span className="font-medium tabular-nums text-text-primary">{Number(batterView.ops).toFixed(3)}</span>
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-[11px] leading-[16px] text-text-tertiary text-center">
                    2026 시즌 기록 준비 중
                  </p>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
