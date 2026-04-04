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

export default function FavoritePlayersSection({ favPlayers }: { favPlayers: FavoritePlayer[] }) {
  if (favPlayers.length === 0) return null;

  return (
    <div>
      <SectionHeader title="⭐ 나의 최애 선수" />
      <div className="flex gap-3 overflow-x-auto hide-scrollbar pb-2">
        {favPlayers.map((player) => {
          const batter = findBatter(player.playerId, player.name, player.teamId);
          const pitcher = findPitcher(player.playerId, player.name, player.teamId);
          // position이 정확히 "투수"가 아니더라도 pitcher stats에 있으면 투수로 표시
          const isPitcher = pitcher ? (!batter || player.position === "투수") : false;
          const hasStats = !!pitcher || !!batter;
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
                    {isPitcher && pitcher ? (
                      <>
                        <div className="flex justify-between text-xs leading-[18px]">
                          <span className="text-text-tertiary">ERA</span>
                          <span className="font-medium tabular-nums text-text-primary">{pitcher.era}</span>
                        </div>
                        <div className="flex justify-between text-xs leading-[18px]">
                          <span className="text-text-tertiary">승·패·세</span>
                          <span className="font-medium tabular-nums text-text-primary">{pitcher.wins ?? 0} · {pitcher.losses ?? 0} · {pitcher.saves ?? 0}</span>
                        </div>
                        <div className="flex justify-between text-xs leading-[18px]">
                          <span className="text-text-tertiary">이닝·K</span>
                          <span className="font-medium tabular-nums text-text-primary">{pitcher.ip} · {pitcher.so}</span>
                        </div>
                      </>
                    ) : batter ? (
                      <>
                        <div className="flex justify-between text-xs leading-[18px]">
                          <span className="text-text-tertiary">타율</span>
                          <span className="font-medium tabular-nums text-text-primary">{Number(batter.avg).toFixed(3)}</span>
                        </div>
                        <div className="flex justify-between text-xs leading-[18px]">
                          <span className="text-text-tertiary">HR·타점</span>
                          <span className="font-medium tabular-nums text-text-primary">{batter.hr} · {batter.rbi}</span>
                        </div>
                        <div className="flex justify-between text-xs leading-[18px]">
                          <span className="text-text-tertiary">OPS</span>
                          <span className="font-medium tabular-nums text-text-primary">{Number(batter.ops).toFixed(3)}</span>
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
