"use client";

import { useParams } from "next/navigation";
import { getTeamBySlug } from "@/lib/constants/teams";
import PostDetail from "@/components/community/PostDetail";

export default function TeamPostDetailPage() {
  const { teamId, postId } = useParams();
  const team = getTeamBySlug(teamId as string);

  return (
    <PostDetail
      postId={Number(postId)}
      headerTitle={team ? `${team.name} 게시판` : "팀 게시판"}
    />
  );
}
