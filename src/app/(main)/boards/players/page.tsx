"use client";

import { motion } from "framer-motion";
import { ArrowLeft, Search } from "lucide-react";
import Link from "next/link";
import GlassCard from "@/components/ui/GlassCard";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { useState, useMemo } from "react";
import { TEAMS } from "@/lib/constants/teams";
import TeamBadge from "@/components/ui/TeamBadge";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
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

function getTeamShortName(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.shortName ?? "";
}

export default function PlayerBoardRankingPage() {
  const [filterTeam, setFilterTeam] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(20);

  const filtered = useMemo(() => {
    let result = PLAYERS;
    
    // 팀 필터
    if (filterTeam) {
      result = result.filter(p => p.teamId === filterTeam);
    }
    
    // 검색
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(p => p.name.toLowerCase().includes(q));
    }
    
    return result;
  }, [filterTeam, searchQuery]);

  return (
    <div className="min-h-screen bg-bg-primary">
      <div className="mx-auto max-w-lg px-5">
        {/* Header */}
        <header className="flex items-center justify-between py-5">
          <div className="flex items-center gap-3">
            <Link href="/teams">
              <motion.div whileTap={{ scale: 0.95 }}>
                <ArrowLeft className="h-6 w-6 text-text-primary" />
              </motion.div>
            </Link>
            <div>
              <h1 className="text-xl font-bold text-text-primary">선수게시판 랭킹</h1>
              <p className="text-xs text-text-tertiary">게시글 수 기준 인기 선수</p>
            </div>
          </div>
        </header>

        {/* 검색 */}
        <div className="mb-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-text-tertiary" />
            <input
              type="text"
              placeholder="선수 이름 검색"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setVisibleCount(20); // 검색 시 리셋
              }}
              className="w-full rounded-xl bg-bg-secondary py-3 pl-10 pr-4 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
        </div>

        {/* 팀 필터 */}
        <div className="mb-4 flex gap-2 overflow-x-auto hide-scrollbar pb-2">
          <button
            onClick={() => { setFilterTeam(null); setVisibleCount(20); }}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
              filterTeam === null
                ? "bg-accent text-white"
                : "bg-bg-secondary text-text-secondary hover:bg-bg-tertiary"
            }`}
          >
            전체 ({PLAYERS.length})
          </button>
          {TEAMS.map((t) => {
            const count = PLAYERS.filter(p => p.teamId === t.id).length;
            return (
              <button
                key={t.id}
                onClick={() => { setFilterTeam(t.id); setVisibleCount(20); }}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                  filterTeam === t.id
                    ? "text-white"
                    : "bg-bg-secondary text-text-secondary hover:bg-bg-tertiary"
                }`}
                style={
                  filterTeam === t.id
                    ? { backgroundColor: t.colorPrimary }
                    : undefined
                }
              >
                {t.shortName} ({count})
              </button>
            );
          })}
        </div>

        {/* 결과 수 */}
        <div className="mb-3 text-sm text-text-tertiary">
          {searchQuery ? `검색 결과: ${filtered.length}명` : `총 ${filtered.length}명`}
        </div>

        {/* 선수 목록 */}
        <div className="space-y-3 pb-20">
          {filtered.slice(0, visibleCount).map((player, i) => (
            <Link key={i} href={`/boards/players/${player.kboId}`}>
              <GlassCard pressable className="p-4">
                <div className="flex items-center gap-4">
                  <span className="text-xl font-bold text-text-tertiary w-8 text-center">
                    {i + 1}
                  </span>
                  <PlayerAvatar
                    photoUrl={getPlayerPhotoUrl(player.name)}
                    name={player.name}
                    teamId={player.teamId}
                    size={64}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-semibold text-text-primary whitespace-nowrap">
                        {player.name}
                      </span>
                      <TeamBadge teamId={player.teamId} size="xs" />
                    </div>
                    <p className="text-xs text-text-tertiary mt-0.5">
                      {player.team} · {player.position} · #{player.backNo}
                    </p>
                  </div>
                </div>
              </GlassCard>
            </Link>
          ))}

          {visibleCount < filtered.length && (
            <button
              onClick={() => setVisibleCount(v => v + 20)}
              className="w-full py-3 mt-2 rounded-xl bg-bg-tertiary text-text-secondary text-sm font-medium hover:bg-white/10 transition-colors"
            >
              더보기 ({filtered.length - visibleCount}명 남음)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
