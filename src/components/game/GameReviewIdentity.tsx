"use client";

import Link from "next/link";
import { useState } from "react";
import { Trophy } from "lucide-react";
import TeamBadge from "@/components/ui/TeamBadge";
import TeamLogo from "@/components/ui/TeamLogo";
import { getAvatarPath } from "@/lib/constants/avatars";
import { getTeamById } from "@/lib/constants/teams";

export function ReviewTeamIdentity({ teamId }: { teamId: number }) {
  const team = getTeamById(teamId);
  if (!team) return null;
  return (
    <div className="flex min-h-12 min-w-0 items-center gap-2">
      <TeamLogo team={team} size={32} />
      <div className="min-w-0">
        <p className="text-sm font-bold text-text-primary">{team.shortName} 팬</p>
        <p className="mt-0.5 flex items-center gap-1 text-xs font-semibold text-text-secondary"><Trophy size={12} aria-hidden="true" />BEST</p>
      </div>
    </div>
  );
}

export default function GameReviewIdentity({ authorId, nickname, teamId, avatarUrl, compact = false, onNavigate }: {
  authorId: string;
  nickname: string;
  teamId: number | null;
  avatarUrl?: string | null;
  compact?: boolean;
  onNavigate: () => void;
}) {
  const name = nickname || "팬";
  const avatar = getAvatarPath(avatarUrl ?? null);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  return (
    <Link href={`/profile/${encodeURIComponent(authorId)}`} onClick={onNavigate} aria-label={`${name} 프로필 보기`}
      className={`flex min-h-11 min-w-0 items-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${compact ? "gap-1.5" : "gap-2.5"}`}>
      <span className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-bg-tertiary text-sm font-bold text-text-primary ${compact ? "h-8 w-8" : "h-10 w-10"}`}>
        {avatar && failedAvatar !== avatar ? (
          // eslint-disable-next-line @next/next/no-img-element -- supports the same preset/custom avatar paths as community authors.
          <img src={avatar} alt="" className="h-full w-full object-cover" onError={() => setFailedAvatar(avatar)} />
        ) : Array.from(name)[0]}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate font-semibold text-text-primary ${compact ? "text-xs" : "text-sm"}`}>{name}</span>
        {!compact && <span className="mt-1 block">{teamId ? <TeamBadge teamId={teamId} size="sm" suffix="팬" /> : <span className="text-xs text-text-secondary">응원팀 미설정</span>}</span>}
      </span>
    </Link>
  );
}
