"use client";

import { useParams, useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import { getTeamBySlug } from "@/lib/constants/teams";
import TeamVideos from "@/components/team/TeamVideos";

export default function TeamVideosPage() {
  const params = useParams();
  const router = useRouter();
  const teamSlug = params.teamId as string;
  const team = getTeamBySlug(teamSlug);

  if (!team) {
    return (
      <div className="flex items-center justify-center py-40 text-text-tertiary">
        존재하지 않는 구단입니다
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg pb-24">
      <div className="sticky top-0 z-30 border-b border-border bg-bg-primary" style={{ paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
      <header className="flex items-center gap-2 px-5 min-h-[44px]">
        <button onClick={() => { if (window.history.length > 1) router.back(); else router.push(`/teams/${teamSlug}`); }} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors">
          <ChevronLeft size={24} />
        </button>
        <h1 className="truncate text-lg font-bold text-text-primary flex-1">
          {team.shortName} 공식영상
        </h1>
        <HeaderProfileLink />
      </header>
      </div>
      <div className="px-5">
        <TeamVideos teamSlug={team.slug} />
      </div>
    </div>
  );
}
