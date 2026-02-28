"use client";

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
  if (posts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-text-tertiary">
        <p className="text-sm">아직 글이 없습니다</p>
        <p className="mt-1 text-xs">첫 번째 글을 작성해보세요!</p>
      </div>
    );
  }

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="space-y-2"
    >
      {posts.map((post) => (
        <motion.div key={post.id} variants={item}>
          <PostCard post={post} />
        </motion.div>
      ))}
    </motion.div>
  );
}
