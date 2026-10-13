"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ChevronRight, UserRound } from "lucide-react";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { resolvePlayerIdentity } from "@/lib/utils/resolve-player";

export default function GameReviewNominee({ name, teamId, playerKey, onNavigate, compact = false }: {
  compact?: boolean;
  name: string;
  teamId: number | null;
  playerKey: string | null;
  onNavigate: () => void;
}) {
  const player = useMemo(() => {
    if (!teamId) return null;
    // Stored keys are game-local participant names, not player IDs.
    const positionHint = playerKey?.startsWith("p:") ? "투수" : playerKey?.startsWith("b:") ? "야수" : null;
    const resolved = resolvePlayerIdentity({ name, teamId, positionHint });
    return resolved?.teamId === teamId ? resolved : null;
  }, [name, teamId, playerKey]);
  const className = "grid min-h-11 min-w-0 grid-cols-[32px_minmax(0,1fr)] items-center gap-x-2 gap-y-1 rounded-xl border border-[var(--primary-weak-border)] bg-[var(--primary-weak-bg)] p-2 text-text-primary";
  if (compact) {
    const compactClass = "flex min-h-11 min-w-0 items-center gap-1 rounded-lg px-1 text-xs text-text-secondary focus-visible:outline-2 focus-visible:outline-accent";
    const label = <><span className="shrink-0">수훈</span><span className="truncate font-semibold text-text-primary">{name}</span>{player && <ChevronRight size={12} className="shrink-0" />}</>;
    return player ? <Link href={`/community/players/${player.kboId}`} prefetch={false} onClick={onNavigate} aria-label={`나의 수훈선수 ${name} 선수 상세 보기`} className={compactClass}>{label}</Link> : <div className={compactClass}>{label}</div>;
  }
  const identity = <>
    <span className="col-span-2 flex items-center justify-between gap-1 text-xs text-text-secondary"><span>나의 수훈선수</span>{player && <ChevronRight size={14} className="shrink-0" aria-hidden="true" />}</span>
    {player ? <PlayerAvatar name={name} teamId={teamId ?? undefined} kboId={player.kboId} size={32} showTeamBadge={false} />
      : <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-tertiary"><UserRound size={20} aria-hidden="true" /></span>}
    <span className="block min-w-0 truncate text-sm font-semibold">{name}</span>
  </>;
  return player ? <Link href={`/community/players/${player.kboId}`} prefetch={false} onClick={onNavigate}
    aria-label={`${name} 선수 상세 보기`} className={`${className} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}>{identity}</Link>
    : <div className={className}>{identity}</div>;
}
