"use client";

import { useParams } from "next/navigation";
import { getTeamBySlug } from "@/lib/constants/teams";
import TeamVideos from "@/components/team/TeamVideos";

export default function TeamVideosPage() {
  const params = useParams();
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
      <header className="px-5 py-4">
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
