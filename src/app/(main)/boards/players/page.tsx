"use client";

import { motion } from "framer-motion";
import { ArrowLeft, TrendingUp } from "lucide-react";
import Link from "next/link";
import GlassCard from "@/components/ui/GlassCard";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { TEAMS } from "@/lib/constants/teams";

const MOCK_PLAYER_BOARD_RANKING = [
  { playerId: "p4", name: "김도영", teamId: 6, postsToday: 33, totalPosts: 2341, trend: "up" as const, rank: 1 },
  { playerId: "p1", name: "오스틴", teamId: 1, postsToday: 47, totalPosts: 1284, trend: "up" as const, rank: 2 },
  { playerId: "p3", name: "구자욱", teamId: 8, postsToday: 35, totalPosts: 1102, trend: "same" as const, rank: 3 },
  { playerId: "p2", name: "양현종", teamId: 6, postsToday: 38, totalPosts: 956, trend: "up" as const, rank: 4 },
  { playerId: "p5", name: "문동주", teamId: 9, postsToday: 28, totalPosts: 876, trend: "down" as const, rank: 5 },
  { playerId: "p6", name: "이정후", teamId: 10, postsToday: 25, totalPosts: 834, trend: "up" as const, rank: 6 },
  { playerId: "p7", name: "박동원", teamId: 1, postsToday: 22, totalPosts: 745, trend: "same" as const, rank: 7 },
  { playerId: "p8", name: "나성범", teamId: 3, postsToday: 20, totalPosts: 698, trend: "down" as const, rank: 8 },
  { playerId: "p9", name: "최형우", teamId: 6, postsToday: 18, totalPosts: 654, trend: "same" as const, rank: 9 },
  { playerId: "p10", name: "김하성", teamId: 2, postsToday: 17, totalPosts: 612, trend: "up" as const, rank: 10 },
  { playerId: "p11", name: "페르난데스", teamId: 4, postsToday: 15, totalPosts: 589, trend: "up" as const, rank: 11 },
  { playerId: "p12", name: "소형준", teamId: 5, postsToday: 14, totalPosts: 534, trend: "down" as const, rank: 12 },
  { playerId: "p13", name: "한석현", teamId: 7, postsToday: 12, totalPosts: 478, trend: "same" as const, rank: 13 },
  { playerId: "p14", name: "안우진", teamId: 6, postsToday: 11, totalPosts: 445, trend: "up" as const, rank: 14 },
  { playerId: "p15", name: "이의리", teamId: 2, postsToday: 10, totalPosts: 398, trend: "same" as const, rank: 15 },
];

function getTeamShortName(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.shortName ?? "";
}
function getTeamColor(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.colorPrimary ?? "#888";
}

export default function PlayerBoardRankingPage() {
  return (
    <div className="min-h-screen bg-bg-primary">
      {/* Header */}
      <div className="sticky top-0 z-30 border-b border-border bg-bg-primary/80 backdrop-blur-xl px-4 py-3 flex items-center gap-3">
        <Link href="/" className="p-1 -ml-1">
          <ArrowLeft className="w-5 h-5 text-text-secondary" />
        </Link>
        <div>
          <h1 className="text-lg font-bold text-text-primary">선수게시판 랭킹</h1>
          <p className="text-xs text-text-tertiary">게시글 수 기준 인기 선수</p>
        </div>
        <TrendingUp className="ml-auto w-5 h-5 text-accent" />
      </div>

      <div className="px-4 py-4 space-y-2">
        {MOCK_PLAYER_BOARD_RANKING.map((player, i) => (
          <Link key={player.playerId} href={`/boards/players/${player.playerId}`}>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
            >
              <GlassCard pressable className="p-3">
                <div className="flex items-center gap-3">
                  <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                    i === 0 ? "bg-yellow-500/20 text-yellow-400" :
                    i === 1 ? "bg-gray-400/20 text-gray-300" :
                    i === 2 ? "bg-amber-700/20 text-amber-600" :
                    "bg-bg-tertiary text-text-tertiary"
                  }`}>
                    {player.rank}
                  </span>
                  <PlayerAvatar name={player.name} teamId={player.teamId} photoUrl={getPlayerPhotoUrl(player.name)} size={44} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-text-primary">{player.name}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ backgroundColor: getTeamColor(player.teamId) + "20", color: getTeamColor(player.teamId) }}>
                        {getTeamShortName(player.teamId)}
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-bold text-accent">오늘 {player.postsToday}글</div>
                    <div className="text-xs text-text-tertiary">총 {player.totalPosts.toLocaleString()}글</div>
                  </div>
                  <span className="text-base w-5 text-center">
                    {player.trend === "up" ? "🔥" : player.trend === "down" ? "📉" : "➖"}
                  </span>
                </div>
              </GlassCard>
            </motion.div>
          </Link>
        ))}
      </div>
    </div>
  );
}
