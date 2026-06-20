"use client";

import { useParams } from "next/navigation";
import PostDetail from "@/components/community/PostDetail";
import { resolvePlayerIdentity } from "@/lib/utils/resolve-player";

export default function PlayerPostDetailPage() {
  const { playerId, postId } = useParams();
  const rawId = playerId as string;
  const info = resolvePlayerIdentity(rawId);
  const headerTitle = info
    ? `커뮤니티 > ${info.team} ${info.name}`
    : "커뮤니티";

  return <PostDetail postId={Number(postId)} headerTitle={headerTitle} />;
}
