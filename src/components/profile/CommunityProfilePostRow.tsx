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
  content_type?: string | null;
  image_urls?: string[] | null;
}

/**
 * 사진글은 작성 시 `title: ""` 로 저장된다(WritePhotoPost). 그래서 제목만 그리던 이전 구현은
 * 프로필 목록에서 본문 줄이 통째로 비어 보였다(2026-08-22 하린아빠 지시). 첫 이미지를 썸네일로 쓴다.
 *
 * 판정은 `content_type` 단독이 아니라 **실제 이미지 존재**까지 본다 — photo 인데 image_urls 가 빈
 * 레코드가 실제로 있어서(프로덕션 샘플 200건 중 11건) 그때 깨진 썸네일 상자를 띄우면 더 나쁘다.
 */
export function profilePostThumbnailUrl(post: CommunityProfilePost): string | null {
  const first = post.image_urls?.find(url => typeof url === "string" && url.trim().length > 0);
  return first ?? null;
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
  const thumbnail = profilePostThumbnailUrl(post);
  const title = (post.title ?? "").trim();
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
      <div className="flex min-w-0 items-center gap-3">
        {thumbnail && (
          <img
            src={thumbnail}
            alt=""
            loading="lazy"
            data-profile-post-thumbnail
            className="h-14 w-14 shrink-0 rounded-lg object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          {/* 제목이 비어있으면(사진글 기본값) 빈 줄을 그리지 않는다 — 썸네일이 그 자리를 대신한다. */}
          {title ? (
            <p className="truncate text-sm font-medium text-text-primary">{title}</p>
          ) : thumbnail ? (
            <p className="truncate text-sm font-medium text-text-tertiary">사진</p>
          ) : null}
          <div className={`flex items-center gap-4 text-xs text-text-tertiary ${title || thumbnail ? "mt-1" : ""}`}>
            <span>{timeLabel}</span>
            <span className="flex items-center gap-1"><Heart size={12} /> {post.like_count}</span>
            <span className="flex items-center gap-1"><MessageCircle size={12} /> {post.comment_count}</span>
          </div>
        </div>
      </div>
    </GlassCard>
  );
}
