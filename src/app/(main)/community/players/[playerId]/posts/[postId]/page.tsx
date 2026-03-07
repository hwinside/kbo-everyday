"use client";

import { useParams } from "next/navigation";
import PostDetail from "@/components/community/PostDetail";

export default function PlayerPostDetailPage() {
  const { postId } = useParams();

  return <PostDetail postId={Number(postId)} headerTitle="선수 게시판" />;
}
