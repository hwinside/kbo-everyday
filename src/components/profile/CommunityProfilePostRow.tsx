"use client";

import { Heart, MessageCircle } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import PostScopeBadge from "@/components/community/PostScopeBadge";
import { scopeInputForPost } from "@/lib/utils/post-scope-input";
import { getPostDetailHref } from "@/lib/utils/community-board";

export interface CommunityProfilePost {
  id: number;
  title: string;
  board_type: string;
  board_id: string;
  like_count: number;
  comment_count: number;
  created_at: string;
  team_tags?: string[] | null;
  player_tags?: string[] | null;
}

export default function CommunityProfilePostRow({
  post,
  onNavigate,
  timeLabel,
}: {
  post: CommunityProfilePost;
  onNavigate: (href: string) => void;
  timeLabel: string;
}) {
  const href = getPostDetailHref(post);
  return (
    <GlassCard
      data-community-profile-post-row
      className="p-3 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5"
      data-post-href={href}
      onClick={() => onNavigate(href)}
    >
      {/* 공개범위 — 홈·피드와 동일한 규칙(post-scope SSOT). 프로필 글 목록도 active 소비 경로라
          같이 통일한다 — 안 바꾸면 다팀 글이 여기서만 다른 배지를 달게 된다(삼순 NO-GO 2026-08-06). */}
      <div className="mb-2 flex min-w-0 items-center gap-2" data-community-source-label>
        <span className="shrink-0 text-[10px] text-text-tertiary">공개범위</span>
        <PostScopeBadge post={scopeInputForPost(post)} variant="full" />
      </div>
      <p className="truncate text-sm font-medium text-text-primary">{post.title}</p>
      <div className="mt-1 flex items-center gap-4 text-xs text-text-tertiary">
        <span>{timeLabel}</span>
        <span className="flex items-center gap-1"><Heart size={12} /> {post.like_count}</span>
        <span className="flex items-center gap-1"><MessageCircle size={12} /> {post.comment_count}</span>
      </div>
    </GlassCard>
  );
}
