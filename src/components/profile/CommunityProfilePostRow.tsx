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
  content?: string | null;
}

/**
 * 미리보기 한 줄의 문자 상한. 프로덕션 실측으로 본문 첫 줄은 median 17자·p90 42자지만
 * max 660자라 상한이 없으면 DOM 에 긴 문자열을 그대로 실어 나른다(CSS truncate 는
 * 보이는 것만 가린다). 80자면 p90 을 두 배 이상 덮는다.
 */
export const PROFILE_POST_PREVIEW_MAX = 80;

/**
 * 목록 행에 보여줄 한 줄 텍스트.
 *
 * 제목이 빈 글이 생각보다 많다 — 프로덕션 실측으로 **사진글 1,424건 중 478건**,
 * **일반글 4,435건 중 2,381건**이 `title=""` 이다(사진글은 WritePhotoPost 가 구조적으로
 * 빈 제목을 넣고, 일반글은 유저가 제목 없이 본문만 쓴다). 그래서 제목만 그리던
 * 이전 구현은 목록 절반이 본문 줄 없이 날짜만 떠 있는 화면이었다.
 *
 * 순서: 제목 → 본문 첫 줄. 둘 다 없으면 null 을 돌려 호출부가 썸네일로 대체하게 한다.
 * 본문은 **첫 줄만** 쓴다 — 여러 줄 글(16.9%)을 통째로 넣으면 개행이 공백으로 뭉개져
 * 뜻 모를 문장이 된다. 앞쪽 빈 줄은 건너뛴다.
 */
export function profilePostPreviewText(post: CommunityProfilePost): string | null {
  const title = (post.title ?? "").trim();
  if (title) return title;

  const firstLine = (post.content ?? "")
    .split("\n")
    .map(line => line.trim())
    .find(line => line.length > 0);
  if (!firstLine) return null;

  return firstLine.length > PROFILE_POST_PREVIEW_MAX
    ? `${firstLine.slice(0, PROFILE_POST_PREVIEW_MAX)}\u2026`
    : firstLine;
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
  const preview = profilePostPreviewText(post);
  // 제목도 본문도 없는 순수 사진글은 썸네일이 내용을 대신하므로 "사진"으로 표기한다.
  const previewText = preview ?? (thumbnail ? "사진" : null);
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
          {/* 제목 → 본문 첫 줄 → (사진만 있으면) "사진". 세 경우 모두 아니면 빈 줄을 그리지 않는다. */}
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
