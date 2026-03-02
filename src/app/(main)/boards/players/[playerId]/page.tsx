"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, Heart, MessageCircle, Share2, PenLine } from "lucide-react";
import Link from "next/link";
import GlassCard from "@/components/ui/GlassCard";
import NicheStats from "@/components/player/NicheStats";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { TEAMS } from "@/lib/constants/teams";
import { usePosts } from "@/lib/supabase/usePosts";
import CheerSong from "@/components/player/CheerSong";
import PlayerProfile from "@/components/player/PlayerProfile";
import PhotoGallery from "@/components/player/PhotoGallery";

const PLAYER_DATA: Record<string, { name: string; teamId: number; number: number; position: string; totalPosts: number }> = {
  p1: { name: "오스틴", teamId: 1, number: 31, position: "외야수", totalPosts: 1284 },
  p2: { name: "양현종", teamId: 6, number: 1, position: "투수", totalPosts: 956 },
  p3: { name: "구자욱", teamId: 8, number: 10, position: "외야수", totalPosts: 1102 },
  p4: { name: "김도영", teamId: 6, number: 5, position: "내야수", totalPosts: 2341 },
  p5: { name: "문동주", teamId: 9, number: 29, position: "투수", totalPosts: 876 },
  p6: { name: "이정후", teamId: 10, number: 51, position: "외야수", totalPosts: 834 },
  p7: { name: "박동원", teamId: 1, number: 27, position: "포수", totalPosts: 745 },
  p8: { name: "나성범", teamId: 3, number: 47, position: "외야수", totalPosts: 698 },
  p9: { name: "최형우", teamId: 6, number: 34, position: "지명타자", totalPosts: 654 },
  p10: { name: "김하성", teamId: 2, number: 7, position: "내야수", totalPosts: 612 },
  p11: { name: "페르난데스", teamId: 4, number: 37, position: "투수", totalPosts: 589 },
  p12: { name: "소형준", teamId: 5, number: 11, position: "투수", totalPosts: 534 },
  p13: { name: "한석현", teamId: 7, number: 18, position: "외야수", totalPosts: 478 },
  p14: { name: "안우진", teamId: 6, number: 26, position: "투수", totalPosts: 445 },
  p15: { name: "이의리", teamId: 2, number: 17, position: "투수", totalPosts: 398 },
};


function getTeamColor(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.colorPrimary ?? "#888";
}
function getTeamShortName(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.shortName ?? "";
}

export default function PlayerBoardPage() {
  const { playerId } = useParams();
  const player = PLAYER_DATA[playerId as string];
  const [activeTab, setActiveTab] = useState<"stats" | "photo" | "latest" | "hot">("stats");
  const { posts: livePosts, loading: postsLoading } = usePosts("player", playerId as string);

  if (!player) {
    return (
      <div className="flex items-center justify-center h-screen text-text-secondary">
        선수를 찾을 수 없습니다
      </div>
    );
  }

  const teamColor = getTeamColor(player.teamId);

  return (
    <div className="min-h-screen bg-bg-primary pb-20">
      {/* Header */}
      <div
        className="sticky top-0 z-30 border-b border-border backdrop-blur-xl"
        style={{ background: `linear-gradient(135deg, ${teamColor}15, transparent)` }}
      >
        <div className="flex items-center gap-4 px-5 py-4">
          <Link href="/boards/players" className="p-1 -ml-1">
            <ArrowLeft className="w-10 h-10 text-text-secondary" />
          </Link>
          <PlayerAvatar name={player.name} teamId={player.teamId} photoUrl={getPlayerPhotoUrl(player.name)} number={player.number} size={64} />
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-text-primary">{player.name}</h1>
              <span className="text-base px-1.5 py-0.5 rounded-full" style={{ backgroundColor: teamColor + "20", color: teamColor }}>
                #{player.number}
              </span>
            </div>
            <p className="text-base text-text-tertiary">{getTeamShortName(player.teamId)} · {player.position} · 게시글 {player.totalPosts.toLocaleString()}개</p>
          </div>
          
          <button onClick={async () => {
            const url = window.location.href;
            if (navigator.share) {
              await navigator.share({ title: `${player.name} - 크보 에브리데이`, url });
            } else {
              await navigator.clipboard.writeText(url);
              alert("링크가 복사되었습니다!");
            }
          }}>
            <Share2 className="w-5 h-5 text-text-tertiary" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-t border-border">
          {((["stats", "photo", "latest", "hot"] as const)).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-3 text-base font-medium transition-colors relative ${
                activeTab === tab ? "text-text-primary" : "text-text-tertiary"
              }`}
            >
              {tab === "stats" ? "스탯" : tab === "photo" ? "📸 직찍" : tab === "latest" ? "최신" : "인기"}
              {activeTab === tab && (
                <motion.div
                  layoutId="board-tab"
                  className="absolute bottom-0 left-0 right-0 h-0.5"
                  style={{ backgroundColor: teamColor }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Stats tab */}
      {activeTab === "stats" && (
        <div className="px-5 py-4">
          <PlayerProfile playerName={player.name} teamColor={teamColor} />
          <CheerSong playerName={player.name} teamColor={teamColor} />
          <NicheStats playerId={playerId as string} position={player.position} teamColor={teamColor} />
        </div>
      )}

      {/* 직찍 갤러리 */}
      {activeTab === "photo" && (
        <div className="py-2">
          <PhotoGallery teamColor={teamColor} />
        </div>
      )}

      {/* Posts */}
      {activeTab !== "stats" && activeTab !== "photo" && <div className="px-5 py-4 space-y-5">
        {(livePosts.length === 0 && !postsLoading) ? (
          <div className="text-center py-12 text-text-tertiary">
            <p className="text-sm">아직 게시글이 없어요</p>
            <p className="text-xs mt-1">첫 번째 글을 작성해보세요!</p>
          </div>
        ) : livePosts.map((post, i) => (
          <motion.div
            key={post.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
          >
            <Link href={`/boards/players/${playerId}/posts/${post.id}`}><GlassCard pressable className="p-4">
              <p className="text-base font-medium text-text-primary">{post.title}</p>
              <div className="mt-2 flex items-center justify-between text-base text-text-tertiary">
                <span>{post.nickname || "익명"} · {new Date(post.created_at).toLocaleDateString("ko-KR")}</span>
                <div className="flex items-center gap-4">
                  <span className="flex items-center gap-1"><Heart size={22} /> {post.like_count}</span>
                  <span className="flex items-center gap-1"><MessageCircle size={22} /> {post.comment_count}</span>
                </div>
              </div>
            </GlassCard></Link>
          </motion.div>
        ))}
      </div>}

      {/* FAB - Write (only on post tabs) */}
      {(activeTab === "latest" || activeTab === "hot") && (
      <button
        className="fixed bottom-24 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full shadow-lg"
        style={{ backgroundColor: teamColor }}
      >
        <PenLine className="w-9 h-9 text-white" />
      </button>
      )}
    </div>
  );
}
