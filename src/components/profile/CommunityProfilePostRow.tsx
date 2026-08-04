"use client";

import { Heart, MessageCircle } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import { getPostDetailHref, getPostSourceLabel } from "@/lib/utils/community-board";

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
  const sourceLabel = getPostSourceLabel(post);
  const href = getPostDetailHref(post);
  return (
    <GlassCard
      data-community-profile-post-row
      className="p-3 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5"
      data-post-href={href}
      onClick={() => onNavigate(href)}
    >
      <div className="mb-2 flex min-w-0 items-center gap-2" data-community-source-label>
        <span className="shrink-0 text-[10px] text-text-tertiary">글 소속</span>
        {sourceLabel.teamId ? (
          <TeamBadge teamId={sourceLabel.teamId} playerName={sourceLabel.playerName} size="sm" />
        ) : (
          <span className="min-w-0 truncate rounded-full bg-bg-tertiary px-2.5 py-1 text-sm font-bold text-text-primary">
            {sourceLabel.text}
          </span>
        )}
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
