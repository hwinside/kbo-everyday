"use client";

import { motion, AnimatePresence } from "framer-motion";
import PostList from "@/components/community/PostList";
import PhotoFeed from "@/components/community/PhotoFeed";
import type { Post } from "@/lib/types";
import type { Post as RawPost } from "@/lib/supabase/usePosts";
import type { FavoritePlayer } from "@/lib/store/favorites";
import type { ContentTab } from "@/hooks/usePlayerCommunity";

interface PlayerPostContentProps {
  contentTab: ContentTab;
  loading: boolean;
  photoLoading: boolean;
  filteredPosts: Post[];
  filteredPhotoPosts: RawPost[];
  favPlayers: FavoritePlayer[];
  onPhotoLike: (postId: number) => void;
}

function buildPlayerLabels(
  postList: { id: number; boardId?: string; board_id?: string }[],
  favPlayers: FavoritePlayer[],
) {
  const labels: Record<number, { teamId: number; playerName: string }> = {};
  postList.forEach((post) => {
    const bid = post.boardId ?? post.board_id;
    const fav = favPlayers.find((p) => p.playerId === bid);
    if (fav) labels[post.id] = { teamId: fav.teamId, playerName: fav.name };
  });
  return labels;
}

export default function PlayerPostContent({
  contentTab,
  loading,
  photoLoading,
  filteredPosts,
  filteredPhotoPosts,
  favPlayers,
  onPhotoLike,
}: PlayerPostContentProps) {
  return (
    <AnimatePresence mode="wait">
      {contentTab === "general" ? (
        <motion.div
          key="general-posts"
          initial={{ opacity: 0, x: -12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -12 }}
          transition={{ duration: 0.15 }}
          className="px-5 py-3"
        >
          {loading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="glass-card p-5 animate-pulse">
                  <div className="h-4 bg-bg-tertiary rounded w-24 mb-3" />
                  <div className="h-5 bg-bg-tertiary rounded w-3/4 mb-2" />
                  <div className="h-4 bg-bg-tertiary rounded w-full" />
                </div>
              ))}
            </div>
          ) : filteredPosts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-text-tertiary">
              <p className="text-base">아직 글이 없습니다</p>
              <p className="mt-1 text-sm">최애선수 게시판에 첫 글을 작성해보세요!</p>
            </div>
          ) : (
            <PostList posts={filteredPosts} playerLabels={buildPlayerLabels(filteredPosts, favPlayers)} />
          )}
        </motion.div>
      ) : (
        <motion.div
          key="photo-posts"
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 12 }}
          transition={{ duration: 0.15 }}
          className="py-3"
        >
          <PhotoFeed
            posts={filteredPhotoPosts}
            loading={photoLoading}
            onLike={onPhotoLike}
            boardType="player"
            playerLabels={buildPlayerLabels(filteredPhotoPosts, favPlayers)}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
