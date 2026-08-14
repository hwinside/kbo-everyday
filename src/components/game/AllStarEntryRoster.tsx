"use client";
import Link from "next/link";
import Image from "next/image";
import { getTeamById, ALLSTAR_NANUM_ID, ALLSTAR_DREAM_ID } from "@/lib/constants/teams";
import {
  ALLSTAR_2026_NANUM_ENTRY,
  ALLSTAR_2026_DREAM_ENTRY,
  type AllStarEntry,
} from "@/lib/constants/allstar-2026";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { getCanonicalPlayerHref } from "@/lib/utils/resolve-player";

const GROUP_ORDER: AllStarEntry["group"][] = ["투수", "포수", "내야수", "외야수", "지명타자"];

function EntryRow({ entry }: { entry: AllStarEntry }) {
  const team = getTeamById(entry.teamId)!;
  const href = getCanonicalPlayerHref({ kboId: entry.kboId }) ?? `/community/players/${encodeURIComponent(entry.name)}`;
  return (
    <Link href={href} prefetch={false} className="flex items-center gap-2 py-1.5 hover:opacity-80">
      <PlayerAvatar
        name={entry.name}
        teamId={entry.teamId}
        photoUrl={getPlayerPhotoUrl(entry.name, entry.kboId, entry.teamId)}
        size={32}
        showTeamBadge={false}
      />
      <span className="text-sm text-text-primary font-medium">{entry.name}</span>
      <span className="text-xs font-semibold" style={{ color: team.colorLight }}>{team.shortName}</span>
      {entry.best12 && (
        <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-500 shrink-0">
          베스트12
        </span>
      )}
    </Link>
  );
}

function SideRoster({ allstarTeamId, entries }: { allstarTeamId: number; entries: AllStarEntry[] }) {
  const side = getTeamById(allstarTeamId)!;
  return (
    <div className="glass-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-7 h-7 rounded-full bg-white p-0.5 flex items-center justify-center">
          <Image src={side.logoPath} alt={side.shortName} width={18} height={18} unoptimized className="object-contain" />
        </div>
        <span className="text-sm font-bold" style={{ color: side.colorLight }}>{side.name}</span>
        <span className="text-xs text-text-tertiary ml-auto">{entries.length}명</span>
      </div>
      {GROUP_ORDER.map((group) => {
        const players = entries.filter((e) => e.group === group);
        if (players.length === 0) return null;
        return (
          <div key={group} className="mb-2 last:mb-0">
            <div className="text-[11px] text-text-tertiary font-medium border-b border-border/50 pb-1 mb-1">{group}</div>
            {players.map((e) => (
              <EntryRow key={e.kboId} entry={e} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 올스타전 확정 엔트리 명단 (타순 게시 전 라인업 탭 대체 뷰).
 * KBO 발표(6/29) 50명 — 나눔/드림 각 25명, 원소속 팀명 병기 (하린아빠 2026-07-11).
 */
export default function AllStarEntryRoster() {
  return (
    <div className="px-4 py-4 space-y-4">
      <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
        <span className="text-yellow-400 text-sm">⚠️</span>
        <span className="text-sm text-yellow-400/90">엔트리는 확정됐어요. 선발 타순은 발표 전 — 발표되면 자동 반영됩니다.</span>
      </div>
      <SideRoster allstarTeamId={ALLSTAR_NANUM_ID} entries={ALLSTAR_2026_NANUM_ENTRY} />
      <SideRoster allstarTeamId={ALLSTAR_DREAM_ID} entries={ALLSTAR_2026_DREAM_ENTRY} />
    </div>
  );
}
