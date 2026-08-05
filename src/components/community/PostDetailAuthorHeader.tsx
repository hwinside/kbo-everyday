"use client";

import type { ReactNode } from "react";
import CommunityAuthorHeader from "@/components/community/CommunityAuthorHeader";
import PostViewBadge from "@/components/community/PostViewBadge";
import DMButton from "@/components/ui/DMButton";

interface PostDetailAuthorHeaderProps {
  nickname?: string | null;
  teamId?: number | null;
  avatarUrl?: string | null;
  authorId?: string | null;
  viewerId?: string | null;
  isStaff?: boolean;
  timeLabel: string;
  isEdited?: boolean;
  clickCount?: number | null;
  impressionCount?: number | null;
  menu?: ReactNode;
  className?: string;
}

/** 게시글 상세의 실제 작성자 메타 조합. 브라우저 회귀 게이트도 이 컴포넌트를 렌더한다. */
export default function PostDetailAuthorHeader({
  nickname,
  teamId,
  avatarUrl,
  authorId,
  viewerId,
  isStaff,
  timeLabel,
  isEdited,
  clickCount,
  impressionCount,
  menu,
  className,
}: PostDetailAuthorHeaderProps) {
  return (
    <CommunityAuthorHeader
      className={className}
      nickname={nickname}
      teamId={teamId}
      avatarUrl={avatarUrl}
      profileHref={authorId ? `/profile/${authorId}` : null}
      isStaff={isStaff}
      meta={
        <>
          {authorId && viewerId && authorId !== viewerId ? (
            <DMButton targetUserId={authorId} size="sm" className="shrink-0" />
          ) : null}
          <span className="shrink-0 text-xs text-text-tertiary">
            {timeLabel}{isEdited ? " · 수정됨" : ""}
          </span>
          <PostViewBadge clickCount={clickCount} impressionCount={impressionCount} className="shrink-0" />
        </>
      }
      menu={menu}
    />
  );
}
