"use client";

import { Heart, MessageCircle, Play } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import PostScopeBadge from "@/components/community/PostScopeBadge";
import { scopeInputForPost } from "@/lib/utils/post-scope-input";
import { getPostDetailHref } from "@/lib/utils/community-board";
import {
  profilePostPreviewFallback,
  profilePostPreviewText,
  profilePostThumbnail,
  type CommunityProfilePost,
} from "@/lib/utils/profile-post-preview";

// 표시 판정(미리보기·썸네일)은 순수 계약이라 @/lib/utils/profile-post-preview 가 소유한다.
// 여기서 다시 내보내는 이유는 기존 import 경로를 유지하기 위함이다.
export type { CommunityProfilePost };
export {
  PHOTO_CONTENT_TYPE,
  PROFILE_POST_PREVIEW_MAX,
  profilePostPreviewText,
  profilePostThumbnail,
} from "@/lib/utils/profile-post-preview";

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
  const thumbnail = profilePostThumbnail(post);
  const preview = profilePostPreviewText(post);
  // 제목도 본문도 없는 순수 미디어글은 썸네일이 내용을 대신하므로 종류를 글로 밝힌다.
  const previewText = preview ?? profilePostPreviewFallback(thumbnail);
  const previewMuted = preview == null;
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
        {thumbnail?.kind === "image" && (
          <img
            src={thumbnail.url}
            alt=""
            loading="lazy"
            data-profile-post-thumbnail="image"
            className="h-14 w-14 shrink-0 rounded-lg object-cover"
          />
        )}
        {/* 영상글은 포스터 URL 이 없어 재생 아이콘 플레이스홀더로 대신한다(전수 161건). */}
        {thumbnail?.kind === "video" && (
          <div
            data-profile-post-thumbnail="video"
            aria-label="영상"
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-black/10 text-text-tertiary dark:bg-white/10"
          >
            <Play size={20} className="fill-current" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          {/* 제목 → 본문 첫 줄 → (미디어만 있으면) 종류. 셋 다 아니면 빈 줄을 그리지 않는다. */}
          {previewText !== null && (
            <p
              data-profile-post-preview
              className={`truncate text-sm font-medium ${previewMuted ? "text-text-tertiary" : "text-text-primary"}`}
            >
              {previewText}
            </p>
          )}
          <div className={`flex items-center gap-4 text-xs text-text-tertiary ${previewText !== null ? "mt-1" : ""}`}>
            <span>{timeLabel}</span>
            <span className="flex items-center gap-1"><Heart size={12} /> {post.like_count}</span>
            <span className="flex items-center gap-1"><MessageCircle size={12} /> {post.comment_count}</span>
          </div>
        </div>
      </div>
    </GlassCard>
  );
}
