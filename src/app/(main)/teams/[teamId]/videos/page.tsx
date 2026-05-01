"use client";

import { useParams, useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
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
      <header className="flex items-center gap-2 px-5 py-4">
        <button onClick={() => { if (window.history.length > 1) router.back(); else router.push(`/teams/${teamSlug}`); }} className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors">
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-lg font-bold text-text-primary">
          {team.shortName} 공식영상
        </h1>
      </header>
      <div className="px-5">
        <TeamVideos teamSlug={team.slug} />
      </div>
    </div>
  );
}
