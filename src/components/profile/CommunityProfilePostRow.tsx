"use client";

import { Heart, MessageCircle, Play } from "lucide-react";
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
  video_urls?: string[] | null;
  content?: string | null;
}

/** 사진글 판정의 SSOT — posts.content_type 의 값. */
export const PHOTO_CONTENT_TYPE = "photo";

/** 빈 문자열·공백·비문자열을 걸러낸 첫 유효 URL. */
function firstUsableUrl(urls: string[] | null | undefined): string | null {
  return urls?.find(url => typeof url === "string" && url.trim().length > 0) ?? null;
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
 * 목록 행 왼쪽 썸네일 슬롯의 모양.
 *
 *   image — 첫 이미지를 그대로
 *   video — 재생 아이콘 플레이스홀더(영상은 포스터 URL 이 따로 없다)
 *   null  — 슬롯 자체를 그리지 않음
 */
export type ProfilePostThumbnail =
  | { kind: "image"; url: string }
  | { kind: "video" };

/**
 * 사진글은 작성 시 `title: ""` 로 저장된다(WritePhotoPost). 그래서 제목만 그리던 이전 구현은
 * 프로필 목록에서 본문 줄이 통째로 비어 보였다(2026-08-22 하린아빠 지시).
 *
 * **사진글에만** 썸네일을 단다(삼순 NO-GO 2026-08-22). 이전 판본은 content_type 을 안 보고
 * image_urls 만 봐서 이미지가 달린 일반글에도 썸네일을 그렸다 — 일반글은 제목·본문이
 * 주인공이므로 사진을 앞에 세우면 목록의 읽힘이 깨진다. 전수 실측상 일반글 4,440건 중
 * 이미지 보유는 5건으로 적지만 0 이 아니라 실제로 오작동하는 경로다.
 *
 * 사진글인데 이미지가 없는 경우는 **전수 1,424건 중 161건**이고 그 **161건이 전부 영상을
 * 가진다** — 그래서 이미지 부재를 "미디어 없음"으로 취급하면 영상글이 다시 날짜만 남는
 * 행이 된다(내가 앞서 "샘플 200건 중 11건"이라 보고한 것은 절단된 분모였다).
 */
export function profilePostThumbnail(post: CommunityProfilePost): ProfilePostThumbnail | null {
  if (post.content_type !== PHOTO_CONTENT_TYPE) return null;
  const image = firstUsableUrl(post.image_urls);
  if (image) return { kind: "image", url: image };
  if (firstUsableUrl(post.video_urls)) return { kind: "video" };
  return null;
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
  const thumbnail = profilePostThumbnail(post);
  const preview = profilePostPreviewText(post);
  // 제목도 본문도 없는 순수 미디어글은 썸네일이 내용을 대신하므로 종류를 글로 밝힌다.
  const previewText = preview ?? (thumbnail === null ? null : thumbnail.kind === "video" ? "영상" : "사진");
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
        {/* 영상글은 포스터 URL 이 없어 재생 아이콘 플레이스홀더로 대신한다(161건). */}
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
