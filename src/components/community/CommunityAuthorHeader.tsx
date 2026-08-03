"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import TeamBadge from "@/components/ui/TeamBadge";
import { getAvatarPath } from "@/lib/constants/avatars";

interface CommunityAuthorHeaderProps {
  nickname?: string | null;
  teamId?: number | null;
  avatarUrl?: string | null;
  profileHref?: string | null;
  isStaff?: boolean;
  meta?: ReactNode;
  menu?: ReactNode;
  className?: string;
}

/** 피드·상세·댓글 공용 작성자 헤더: 40px 아바타 / 1행 아이디 / 2행 메타. */
export default function CommunityAuthorHeader({
  nickname,
  teamId,
  avatarUrl,
  profileHref,
  isStaff = false,
  meta,
  menu,
  className = "",
}: CommunityAuthorHeaderProps) {
  const displayName = nickname || "익명";
  const avatarPath = getAvatarPath(avatarUrl ?? null);
  const avatar = (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/20 bg-bg-tertiary text-sm font-bold text-text-primary">
      {avatarPath ? (
        // eslint-disable-next-line @next/next/no-img-element -- preset/custom avatar path can be local or user storage.
        <img src={avatarPath} alt="" className="h-full w-full object-cover" />
      ) : displayName[0]}
    </span>
  );

  return (
    <div data-community-author-header className={`flex min-w-0 items-start gap-2.5 ${className}`}>
      {profileHref ? (
        <Link href={profileHref} aria-label={`${displayName} 프로필 보기`} className="shrink-0 active:opacity-70">
          {avatar}
        </Link>
      ) : avatar}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          {profileHref ? (
            <Link href={profileHref} className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-primary active:opacity-70">
              {displayName}
            </Link>
          ) : (
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-primary">{displayName}</span>
          )}
          {isStaff && (
            <span className="shrink-0 rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-bold text-accent">운영팀</span>
          )}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          {teamId ? <TeamBadge teamId={teamId} size="xs" suffix="팬" /> : null}
          {meta}
          {menu ? <div className="ml-auto shrink-0">{menu}</div> : null}
        </div>
      </div>
    </div>
  );
}
