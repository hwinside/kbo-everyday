"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, Pencil } from "lucide-react";
import { getTeamBySlug, getTeamBgColor } from "@/lib/constants/teams";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { getPlayerById, getPlayerGameLog } from "@/lib/constants/players";
import PlayerStatCard from "@/components/stats/PlayerStatCard";
import PostList from "@/components/community/PostList";
import WritePost from "@/components/community/WritePost";
import type { Post } from "@/lib/types";

type PlayerTab = "stats" | "board";

function generatePlayerPosts(playerName: string, teamId: number): Post[] {
  const titles = [
    `${playerName} 오늘 경기 리뷰`,
    `${playerName} 시즌 성적 분석`,
    `${playerName} 폼이 올라오고 있다`,
    `${playerName} 응원합니다!`,
    `${playerName} 이번 시리즈 활약 예상`,
  ];
  const authors = [
    { nickname: "야구광팬", level: 15, title: "골드글러브", myTeamId: teamId, avatarUrl: null },
    { nickname: "직관러", level: 8, title: "레귤러", myTeamId: teamId, avatarUrl: null },
    { nickname: "통계매니아", level: 22, title: "MVP", myTeamId: teamId, avatarUrl: null },
  ];
  return titles.map((title, i) => ({
    id: i + 1,
    boardType: "player" as const,
    boardId: String(i),
    authorId: `user-${i}`,
    title,
    content: "게시글 내용이 여기에 표시됩니다.",
    imageUrls: [],
    likeCount: Math.floor(Math.random() * 30) + 5,
    commentCount: Math.floor(Math.random() * 15),
    isReported: false,
    createdAt: new Date(Date.now() - i * 7200000).toISOString(),
    author: authors[i % authors.length],
  }));
}

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
};

export default function PlayerDetailPage() {
  const params = useParams();
  const teamSlug = params.teamId as string;
  const playerId = Number(params.playerId);
  const team = getTeamBySlug(teamSlug);
  const player = getPlayerById(playerId);

  const [activeTab, setActiveTab] = useState<PlayerTab>("stats");
  const [writeOpen, setWriteOpen] = useState(false);

  if (!team || !player) {
    return (
      <div className="flex flex-col items-center justify-center py-40 gap-4">
        <p className="text-text-tertiary">선수 정보를 준비 중입니다</p>
        <button
          onClick={() => window.history.back()}
          className="text-sm text-accent hover:underline"
        >
          ← 돌아가기
        </button>
      </div>
    );
  }

  const gameLog = getPlayerGameLog(playerId);
  const posts = generatePlayerPosts(player.name, team.id);

  return (
    <div className="mx-auto max-w-lg">
      {/* Header with gradient */}
      <div
        className="relative px-5 pb-5 pt-safe"
        style={{
          background: `linear-gradient(180deg, ${getTeamBgColor(team)}33 0%, transparent 100%)`,
        }}
      >
        <div className="flex items-center gap-4 py-5">
          <Link
            href={`/teams/${teamSlug}`}
            className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary/50 transition-colors"
          >
            <ChevronLeft size={24} />
          </Link>
          <PlayerAvatar name={player.name} teamId={team.id} photoUrl={getPlayerPhotoUrl(player.name, String(playerId))} number={player.number} size={72} />
          <h1 className="text-xl font-bold text-text-primary">{player.name}</h1>
        </div>

        {/* Tabs: 스탯 / 게시판 */}
        <div className="flex gap-3">
          {(["stats", "board"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`rounded-full px-5 py-2 text-base font-medium transition-colors ${
                activeTab === tab
                  ? "bg-text-primary text-bg-primary"
                  : "bg-bg-glass text-text-secondary"
              }`}
            >
              {tab === "stats" ? "기록" : "게시판"}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait">
        {activeTab === "stats" ? (
          <motion.div
            key="stats"
            variants={container}
            initial="hidden"
            animate="show"
            exit={{ opacity: 0, x: -20 }}
            className="px-5 py-4"
          >
            <PlayerStatCard
              player={player}
              stats={player.seasonStats}
              gameLog={gameLog}
              teamColor={team.colorPrimary}
              teamName={team.name}
            />
          </motion.div>
        ) : (
          <motion.div
            key="board"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.2 }}
            className="px-5 py-4"
          >
            <PostList posts={posts} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* FAB — Write post (only on board tab) */}
      {activeTab === "board" && (
        <motion.button
          onClick={() => setWriteOpen(true)}
          className="fixed bottom-24 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full shadow-lg"
          style={{ backgroundColor: getTeamBgColor(team) }}
          whileTap={{ scale: 0.9 }}
          whileHover={{ scale: 1.05 }}
        >
          <Pencil size={24} className="text-white" />
        </motion.button>
      )}

      <WritePost
        isOpen={writeOpen}
        onClose={() => setWriteOpen(false)}
        teamName={`${player.name} 게시판`}
      />
    </div>
  );
}
