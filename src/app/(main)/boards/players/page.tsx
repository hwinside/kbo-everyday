"use client";

import { motion } from "framer-motion";
import { ArrowLeft, TrendingUp } from "lucide-react";
import Link from "next/link";
import GlassCard from "@/components/ui/GlassCard";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { useState, useEffect } from "react";
import { getPlayerPhotoUrl, PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";
import { TEAMS } from "@/lib/constants/teams";
import TeamBadge from "@/components/ui/TeamBadge";

interface PlayerItem {
  playerId: string;
  name: string;
  teamId: number;
  team: string;
  position: string;
  backNo: string;
}


function getTeamShortName(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.shortName ?? "";
}
function getTeamColor(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.colorPrimary ?? "#888";
}

export default function PlayerBoardRankingPage() {
  const [players, setPlayers] = useState<PlayerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterTeam, setFilterTeam] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/player-teams").then(r => r.json()).then(d => {
      setPlayers((d.players || []).map((p: any) => ({
        playerId: p.kboId, name: p.name, teamId: p.teamId,
        team: p.team, position: p.position, backNo: p.backNo,
      })));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const filtered = filterTeam ? players.filter(p => p.teamId === filterTeam) : players;

  return (
    <div className="min-h-screen bg-bg-primary">
      {/* Header */}
      <div className="sticky top-0 z-30 pt-safe border-b border-border bg-bg-primary/80 backdrop-blur-xl pt-safe px-5 py-4 flex items-center gap-4">
        <Link href="/" className="p-1 -ml-1">
          <ArrowLeft className="w-10 h-10 text-text-secondary" />
        </Link>
        <div>
          <h1 className="text-xl font-bold text-text-primary">선수게시판 랭킹</h1>
          <p className="text-base text-text-tertiary">게시글 수 기준 인기 선수</p>
        </div>
        <TrendingUp className="ml-auto w-10 h-10 text-accent" />
      </div>

      {/* Team filter */}
      <div className="px-5 py-3 flex gap-2 overflow-x-auto no-scrollbar">
        <button
          onClick={() => setFilterTeam(null)}
          className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
            !filterTeam ? "bg-accent text-white" : "bg-bg-tertiary text-text-secondary"
          }`}
        >전체 ({players.length})</button>
        {TEAMS.map(t => {
          const count = players.filter(p => p.teamId === t.id).length;
          if (count === 0) return null;
          return (
            <button key={t.id} onClick={() => setFilterTeam(t.id)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                filterTeam === t.id ? "bg-accent text-white" : "bg-bg-tertiary text-text-secondary"
              }`}
            >{t.shortName} ({count})</button>
          );
        })}
      </div>

      {/* Player list */}
      <div className="px-5 pb-24 space-y-2">
        {loading ? (
          <div className="text-center py-12 text-text-tertiary text-sm">선수 목록 로딩 중...</div>
        ) : filtered.map((player, i) => (
          <motion.div
            key={player.playerId}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.02, 0.5) }}
          >
            <Link href={`/boards/players/${player.playerId}`}>
              <GlassCard pressable className="flex items-center gap-3 p-4">
                <span className="text-sm font-bold text-text-tertiary w-6 text-center">{i + 1}</span>
                <PlayerAvatar
                  name={player.name}
                  teamId={player.teamId}
                  photoUrl={getPlayerPhotoUrl(player.name)}
                  number={parseInt(player.backNo) || 0}
                  size={48}
                />
                <div className="flex-1">
                  <p className="text-sm font-bold text-text-primary">{player.name}</p>
                  <p className="text-xs text-text-tertiary">{player.team} · {player.position}{player.backNo ? ` · #${player.backNo}` : ""}</p>
                </div>
                <TeamBadge teamId={player.teamId} size="sm" />
              </GlassCard>
            </Link>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
