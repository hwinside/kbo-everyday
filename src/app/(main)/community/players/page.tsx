"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import TeamBadge from "@/components/ui/TeamBadge";
import { TEAMS } from "@/lib/constants/teams";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { getFavoritePlayers, type FavoritePlayer } from "@/lib/store/favorites";
import playersRoster from "@/lib/constants/players-roster.json";

interface PlayerItem {
  name: string;
  kboId: string;
  teamId: number;
  team: string;
  position: string;
  backNo: string;
}

const PLAYERS: PlayerItem[] = playersRoster as PlayerItem[];

export default function CommunityPlayersPage() {
  const [filterTeam, setFilterTeam] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(20);
  const [favPlayers, setFavPlayers] = useState<FavoritePlayer[]>([]);

  useEffect(() => {
    setFavPlayers(getFavoritePlayers());
  }, []);

  const filtered = useMemo(() => {
    let result = PLAYERS;
    if (filterTeam) {
      result = result.filter((p) => p.teamId === filterTeam);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((p) => p.name.toLowerCase().includes(q));
    }
    return result;
  }, [filterTeam, searchQuery]);

  return (
    <div className="mx-auto max-w-lg px-5 pb-24">
      {/* 최애 선수 */}
      {favPlayers.length > 0 && (
        <div className="mt-4 mb-5">
          <h2 className="mb-3 text-base font-bold text-text-primary">최애 선수</h2>
          <div className="flex gap-3 overflow-x-auto hide-scrollbar pb-1">
            {favPlayers.map((player) => (
              <Link key={player.playerId} href={`/community/players/${player.playerId}`}>
                <GlassCard pressable className="flex flex-col items-center gap-2 p-3 min-w-[80px]">
                  <PlayerAvatar
                    name={player.name}
                    teamId={player.teamId}
                    photoUrl={getPlayerPhotoUrl(player.name)}
                    size={44}
                  />
                  <span className="text-xs font-semibold text-text-primary text-center whitespace-nowrap">
                    {player.name}
                  </span>
                </GlassCard>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* 검색 */}
      <div className="mt-4 mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-text-tertiary" />
          <input
            type="text"
            placeholder="선수 이름 검색"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setVisibleCount(20);
            }}
            className="w-full rounded-xl bg-bg-secondary py-3 pl-10 pr-4 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>

      {/* 팀 필터 */}
      <div className="mb-4 flex gap-2 overflow-x-auto hide-scrollbar pb-2">
        <button
          onClick={() => {
            setFilterTeam(null);
            setVisibleCount(20);
          }}
          className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
            filterTeam === null
              ? "bg-accent text-white"
              : "bg-bg-secondary text-text-secondary hover:bg-bg-tertiary"
          }`}
        >
          전체
        </button>
        {TEAMS.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setFilterTeam(t.id);
              setVisibleCount(20);
            }}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
              filterTeam === t.id
                ? "text-white"
                : "bg-bg-secondary text-text-secondary hover:bg-bg-tertiary"
            }`}
            style={filterTeam === t.id ? { backgroundColor: t.colorPrimary } : undefined}
          >
            {t.shortName}
          </button>
        ))}
      </div>

      {/* 선수 목록 */}
      <div className="space-y-3 pb-6">
        {filtered.slice(0, visibleCount).map((player, i) => (
          <Link key={player.kboId || i} href={`/community/players/${player.kboId}`}>
            <GlassCard pressable className="p-4">
              <div className="flex items-center gap-4">
                <PlayerAvatar
                  photoUrl={getPlayerPhotoUrl(player.name)}
                  name={player.name}
                  teamId={player.teamId}
                  size={48}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-semibold text-text-primary">
                      {player.name}
                    </span>
                    <TeamBadge teamId={player.teamId} size="xs" />
                  </div>
                  <p className="text-xs text-text-tertiary mt-0.5">
                    {player.position} · #{player.backNo}
                  </p>
                </div>
              </div>
            </GlassCard>
          </Link>
        ))}

        {visibleCount < filtered.length && (
          <button
            onClick={() => setVisibleCount((v) => v + 20)}
            className="w-full py-3 mt-2 rounded-xl bg-bg-tertiary text-text-secondary text-sm font-medium hover:bg-white/10 transition-colors"
          >
            더보기 ({filtered.length - visibleCount}명 남음)
          </button>
        )}
      </div>
    </div>
  );
}
