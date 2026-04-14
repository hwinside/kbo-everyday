"use client";

import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import PostCard from "./PostCard";
import type { Post } from "@/lib/types";
import type { CommunitySourceLabel } from "@/lib/utils/community-board";

interface PostListProps {
  posts: Post[];
  /** 선수 게시판: post별 playerLabel 맵 (postId → {teamId, playerName}) */
  playerLabels?: Record<number, { teamId: number; playerName: string }>;
  sourceLabels?: Record<number, CommunitySourceLabel>;
}

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.03 } },
};

const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
};

export default function PostList({ posts, playerLabels, sourceLabels }: PostListProps) {
  const router = useRouter();
  if (posts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-text-tertiary">
        <p className="text-base">아직 글이 없습니다</p>
        <p className="mt-1 text-base">첫 번째 글을 작성해보세요!</p>
      </div>
    );
  }

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="space-y-3"
    >
      {posts.map((post) => (
        <motion.div key={post.id} variants={item}>
          <PostCard
            post={post}
            playerLabel={playerLabels?.[post.id] ?? null}
            sourceLabel={sourceLabels?.[post.id] ?? null}
            onPress={() => {
              if (post.boardType === "player") {
                router.push(`/community/players/${post.boardId}/posts/${post.id}`);
              } else if (post.boardType === "team") {
                router.push(`/community/teams/${post.boardId}/posts/${post.id}`);
              } else {
                router.push(`/community/free/${post.id}`);
              }
            }}
          />
        </motion.div>
      ))}
    </motion.div>
  );
}
