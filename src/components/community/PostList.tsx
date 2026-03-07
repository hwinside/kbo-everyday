"use client";

import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import PostCard from "./PostCard";
import type { Post } from "@/lib/types";

interface PostListProps {
  posts: Post[];
}

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.03 } },
};

const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
};

export default function PostList({ posts }: PostListProps) {
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
