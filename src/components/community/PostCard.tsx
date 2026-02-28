"use client";

import { motion } from "framer-motion";
import { Heart, MessageCircle } from "lucide-react";
import TeamBadge from "@/components/ui/TeamBadge";
import LevelBadge from "@/components/ui/LevelBadge";
import type { Post } from "@/lib/types";

interface PostCardProps {
  post: Post;
  onPress?: () => void;
}

export default function PostCard({ post, onPress }: PostCardProps) {
  const timeAgo = getTimeAgo(post.createdAt);

  return (
    <motion.button
      onClick={onPress}
      className="w-full text-left glass-card p-5 transition-colors hover:bg-bg-glass"
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
    >
      {/* Author info */}
      <div className="flex items-center gap-3">
        {post.author?.myTeamId && <TeamBadge teamId={post.author.myTeamId} />}
        <span className="text-base font-medium text-text-primary">
          {post.author?.nickname ?? "익명"}
        </span>
        {post.author && <LevelBadge level={post.author.level} />}
        <span className="ml-auto text-base text-text-tertiary">{timeAgo}</span>
      </div>

      {/* Title */}
      {post.title && (
        <h3 className="mt-2 text-base font-semibold text-text-primary line-clamp-2">
          {post.title}
        </h3>
      )}

      {/* Content preview */}
      <p className="mt-1 text-base text-text-secondary line-clamp-2">
        {post.content}
      </p>

      {/* Image preview */}
      {post.imageUrls.length > 0 && (
        <div className="mt-2 flex gap-4 overflow-hidden">
          {post.imageUrls.slice(0, 3).map((_, i) => (
            <div key={i} className="h-20 w-20 flex-shrink-0 rounded-lg bg-bg-tertiary" />
          ))}
        </div>
      )}

      {/* Stats */}
      <div className="mt-4 flex items-center gap-5 text-base text-text-tertiary">
        <span className="flex items-center gap-1">
          <Heart size={20} /> {post.likeCount}
        </span>
        <span className="flex items-center gap-1">
          <MessageCircle size={20} /> {post.commentCount}
        </span>
      </div>
    </motion.button>
  );
}

function getTimeAgo(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diff = now - date;

  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}일 전`;

  return new Date(dateStr).toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
  });
}
