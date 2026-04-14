"use client";

import { motion } from "framer-motion";
import { Heart, MessageCircle, Play } from "lucide-react";
import TeamBadge from "@/components/ui/TeamBadge";
import LevelBadge from "@/components/ui/LevelBadge";
import LinkPreview from "@/components/community/LinkPreview";
import type { Post } from "@/lib/types";

interface PostCardProps {
  post: Post;
  onPress?: () => void;
  /** 선수 게시판: "LG 김진성" 같은 통합 레이블 (팀 뱃지 대체) */
  playerLabel?: { teamId: number; playerName: string } | null;
}

export default function PostCard({ post, onPress, playerLabel }: PostCardProps) {
  const timeAgo = getTimeAgo(post.createdAt);

  return (
    <motion.button
      onClick={onPress}
      className="w-full text-left glass-card p-5 transition-colors hover:bg-bg-glass"
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
    >
      {/* Author info */}
      <div className="flex items-center gap-3 min-w-0">
        {playerLabel ? (
          <TeamBadge teamId={playerLabel.teamId} playerName={playerLabel.playerName} />
        ) : (
          post.author?.myTeamId ? <TeamBadge teamId={post.author.myTeamId} /> : null
        )}
        <span className="text-base font-medium text-text-primary truncate">
          {post.author?.nickname ?? "익명"}
        </span>
        {post.author?.grade === 'staff' && (
          <span className='ml-1 px-1.5 py-0.5 text-[10px] font-bold bg-accent/20 text-accent rounded-full'>운영팀</span>
        )}
        {post.author && <LevelBadge level={post.author.level} />}
        <span className="ml-auto text-base text-text-tertiary whitespace-nowrap shrink-0">{timeAgo}</span>
      </div>

      {/* Title */}
      {post.title && (
        <h3 className="mt-2 text-base font-semibold text-text-primary line-clamp-2">
          {post.title}
        </h3>
      )}

      {/* Content preview — URLs stripped (OG cards handle links) */}
      <p className="mt-1 text-base text-text-secondary line-clamp-2">
        {stripUrls(post.content)}
      </p>

      {/* Link previews (OG cards + direct image URLs) */}
      <LinkPreview text={post.content} maxPreviews={2} stopPropagation />

      {/* Image preview (uploaded — currently feature-flagged OFF) */}
      {post.imageUrls.length > 0 && (
        <div className="mt-2 flex gap-4 overflow-hidden">
          {post.imageUrls.slice(0, 3).map((_, i) => (
            <div key={i} className="h-20 w-20 flex-shrink-0 rounded-lg bg-bg-tertiary" />
          ))}
        </div>
      )}

      {/* Video indicator */}
      {post.videoUrls && post.videoUrls.length > 0 && (
        <div className="mt-2 flex items-center gap-1.5 text-text-tertiary">
          <Play size={16} fill="currentColor" />
          <span className="text-xs">영상 {post.videoUrls.length}개</span>
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

function stripUrls(text: string): string {
  return text
    .replace(/(?:https?:\/\/|www\.)[^\s<>"')\]]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
