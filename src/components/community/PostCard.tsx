"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Heart, MessageCircle, Play, Share2 } from "lucide-react";
import CommunityAuthorHeader from "@/components/community/CommunityAuthorHeader";
import LinkPreview from "@/components/community/LinkPreview";
import type { Post } from "@/lib/types";
import ShareSheet, { type ShareSheetPost } from "@/components/community/ShareSheet";
import PollCardSlot from "@/components/community/PollCardSlot";
import type { PollSummary } from "@/lib/community/poll-client";

interface PostCardProps {
  post: Post;
  onPress?: () => void;
  /** 선수 게시판: "LG 김진성" 같은 통합 레이블 (팀 뱃지 대체) */
  playerLabel?: { teamId: number; playerName: string } | null;
  /** board_type='poll' 일 때 목록 카드용 요약(배치 조회). 없으면 로딩/terminal 표시. */
  pollSummary?: PollSummary | null;
  /** 배치 요약 조회가 응답됐는지(응답했는데 summary 없으면 terminal). */
  pollLoaded?: boolean;
  /** terminal 카드 재시도. */
  onPollRetry?: () => void;
}

export default function PostCard({ post, onPress, pollSummary, pollLoaded, onPollRetry }: PostCardProps) {
  const timeAgo = getTimeAgo(post.createdAt);
  const isPoll = post.boardType === "poll";
  const [shareOpen, setShareOpen] = useState(false);

  function handleShare(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    setShareOpen(true);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!onPress) return;
    if (e.currentTarget !== e.target) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onPress();
  }

  return (
    <>
    <motion.div
      role="button"
      tabIndex={0}
      onClick={onPress}
      onKeyDown={handleKeyDown}
      className="w-full text-left glass-card p-5 transition-colors hover:bg-bg-glass"
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
    >
      <CommunityAuthorHeader
        nickname={post.author?.nickname}
        teamId={post.author?.myTeamId}
        avatarUrl={post.author?.avatarUrl}
        profileHref={`/profile/${post.authorId}`}
        isStaff={post.author?.grade === "staff"}
        meta={<span className="text-xs text-text-tertiary">{timeAgo}</span>}
      />

      {/* Title */}
      {post.title && (
        <h3 className="mt-2 text-base font-semibold text-text-primary line-clamp-2">
          {post.title}
        </h3>
      )}

      {isPoll ? (
        /* poll 카드: 질문(Title) 아래에 배지·참여수·선지 미리보기. 설명·미디어 대신 렌더. */
        <PollCardSlot summary={pollSummary} loaded={!!pollLoaded} onRetry={onPollRetry ?? (() => {})} />
      ) : (
        <>
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
        </>
      )}

      {/* Stats */}
      <div className="mt-4 flex items-center gap-5 text-base text-text-tertiary">
        <span className="flex items-center gap-1">
          <Heart size={20} /> {post.likeCount}
        </span>
        <span className="flex items-center gap-1">
          <MessageCircle size={20} /> {post.commentCount}
        </span>
        <button
          type="button"
          onClick={handleShare}
          onKeyDown={(e) => e.stopPropagation()}
          className="ml-auto flex min-h-[32px] min-w-[32px] items-center justify-center rounded-lg text-text-tertiary active:bg-bg-tertiary"
          aria-label="게시글 공유"
        >
          <Share2 size={20} />
        </button>
      </div>
    </motion.div>
    <ShareSheet
      isOpen={shareOpen}
      post={
        shareOpen
          ? ({
              id: post.id,
              title: post.title,
              content: post.content,
              videoUrl: post.videoUrls?.[0] ?? null,
              board_type: post.boardType,
              board_id: post.boardId,
            } satisfies ShareSheetPost)
          : null
      }
      onClose={() => setShareOpen(false)}
    />
    </>
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
